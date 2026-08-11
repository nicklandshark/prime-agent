/**
 * OpenAI Codex (ChatGPT subscription) account pool manager.
 *
 * Wraps the account pool embedded in auth.json (see auth-storage.ts) with:
 * - usage probing (wham/usage endpoint + passive response headers),
 * - manual account selection,
 * - automatic account switching when the active subscription hits its
 *   usage limit (429 usage_limit_reached) mid-request.
 */

import {
	fetchOpenAICodexUsage,
	type OpenAICodexAccountUsageSnapshot,
	type ProviderAuthFailure,
	type ProviderAuthRecovery,
	parseOpenAICodexUsageHeaders,
} from "@earendil-works/pi-ai";
import type { AuthStorage, OpenAICodexOAuthAccount } from "./auth-storage.js";

export interface OpenAICodexAccountView {
	accountId: string;
	email?: string;
	label: string;
	active: boolean;
	usage?: OpenAICodexAccountUsageSnapshot;
}

export interface OpenAICodexAccountChangedEvent {
	provider: "openai-codex";
	accountId: string;
	label: string;
	reason: "manual" | "usage_limit";
}

export type OpenAICodexAccountChangedListener = (event: OpenAICodexAccountChangedEvent) => void;

const ENDPOINT_TTL_MS = 60_000;
const ERROR_TTL_MS = 10_000;
const PROBE_CONCURRENCY = 4;
/** Bound on compare-and-set retries when peer processes keep switching first. */
const MAX_CAS_ATTEMPTS = 3;

/** Marker for candidates whose token refresh failed during a recovery probe. */
const REFRESH_FAILED = Symbol("refresh-failed");
type ProbeResult = OpenAICodexAccountUsageSnapshot | typeof REFRESH_FAILED;

export interface OpenAICodexAccountManagerDeps {
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export class OpenAICodexAccountManager {
	private readonly authStorage: AuthStorage;
	private readonly fetchImpl?: typeof fetch;
	private readonly now: () => number;
	private readonly usageCache = new Map<string, OpenAICodexAccountUsageSnapshot>();
	private readonly listeners = new Set<OpenAICodexAccountChangedListener>();
	private lastKnownActiveAccountId: string | undefined;

	constructor(authStorage: AuthStorage, deps: OpenAICodexAccountManagerDeps = {}) {
		this.authStorage = authStorage;
		this.fetchImpl = deps.fetchImpl;
		this.now = deps.now ?? (() => Date.now());
		this.lastKnownActiveAccountId = this.authStorage.getActiveOpenAICodexAccount()?.accountId;
	}

	/**
	 * Accounts known from storage plus whatever usage is currently cached.
	 * Never touches the network.
	 */
	getCachedAccounts(): OpenAICodexAccountView[] {
		return this.buildViews();
	}

	/**
	 * List accounts; with `refreshUsage`, probe accounts whose cached usage is
	 * stale (endpoint snapshots refresh after 60s, errors after 10s). The
	 * account list itself is re-read under the auth file lock so accounts
	 * added/removed by other processes show up immediately.
	 */
	async listAccounts(options?: { refreshUsage?: boolean; signal?: AbortSignal }): Promise<OpenAICodexAccountView[]> {
		const snapshot = this.snapshotAccounts();
		if (options?.refreshUsage) {
			const stale = snapshot.accounts.filter((account) => !this.hasFreshUsage(account.accountId));
			await this.probeAccounts(stale, { signal: options.signal });
		}
		return this.buildViews(snapshot);
	}

	/**
	 * Manually select the active account. Throws when the account is unknown.
	 */
	selectAccount(accountId: string, reason: "manual" | "usage_limit" = "manual"): OpenAICodexAccountView {
		const account = this.authStorage.setActiveOpenAICodexAccount(accountId);
		if (!account) {
			throw new Error(`Unknown OpenAI Codex account: ${accountId}`);
		}
		this.lastKnownActiveAccountId = account.accountId;
		this.emitAccountChanged(account, reason);
		const view = this.buildViews().find((candidate) => candidate.accountId === account.accountId);
		if (!view) {
			throw new Error(`Unknown OpenAI Codex account: ${accountId}`);
		}
		return view;
	}

	/**
	 * Passive usage update from codex/responses headers. Header data lands
	 * immediately but never overrides newer endpoint data.
	 */
	observeResponse(accountId: string, headers: Record<string, string>): void {
		if (!accountId) return;
		const snapshot = parseOpenAICodexUsageHeaders(headers);
		if (!snapshot) return;
		const existing = this.usageCache.get(accountId);
		if (existing?.source === "endpoint" && existing.fetchedAt >= snapshot.fetchedAt) {
			return;
		}
		this.usageCache.set(accountId, snapshot);
	}

	/**
	 * Recover from a usage_limit_reached 429: re-read the pool under the auth
	 * file lock (so accounts added/removed by other processes are seen),
	 * force-probe every stored account, exclude the failed/attempted/
	 * exhausted/unverifiable ones, switch to the account with the highest
	 * remaining quota, and hand fresh credentials back to the provider for a
	 * request restart.
	 */
	async recoverFromUsageLimit(failure: ProviderAuthFailure): Promise<ProviderAuthRecovery> {
		const initial = this.snapshotAccounts();
		if (initial.accounts.length === 0) {
			return { action: "fail", message: "No ChatGPT subscriptions are stored." };
		}

		const failedAccountId = failure.accountId ?? initial.activeAccountId;
		const attempted = new Set<string>(failure.attemptedAccountIds);
		if (failedAccountId) {
			attempted.add(failedAccountId);
		}

		// Probe results are kept across CAS retries so re-evaluating the pool
		// after a lost race does not re-hit the usage endpoint.
		const probes = new Map<string, ProbeResult>();
		const exhaustedResetAts: number[] = [];
		const failedCheckIds = new Set<string>();
		let totalAccounts = initial.accounts.length;

		if (failure.resetsAt !== undefined) {
			exhaustedResetAts.push(failure.resetsAt);
		}

		// The CAS may lose to another process that switched first. Its choice
		// is only adopted when it is usable for THIS request (not already
		// attempted here, not exhausted, verifiable); otherwise recompute
		// against fresh storage and retry from the account just observed as
		// active. Bounded so a flapping peer cannot spin this loop forever.
		let expectedActiveId = failedAccountId ?? initial.activeAccountId ?? "";
		let sawEligible = false;

		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
			const snapshot = attempt === 0 ? initial : this.snapshotAccounts();
			totalAccounts = snapshot.accounts.length;
			const candidates = snapshot.accounts.filter((account) => !attempted.has(account.accountId));

			// Force-probe newly considered candidates (TTLs bypassed): a
			// usage_limit failure means cached snapshots can no longer be trusted.
			const unprobed = candidates.filter((account) => !probes.has(account.accountId));
			const freshProbes = await this.probeAccounts(unprobed);
			for (const [accountId, result] of freshProbes) {
				probes.set(accountId, result);
			}

			const eligible: { account: OpenAICodexOAuthAccount; snapshot: OpenAICodexAccountUsageSnapshot }[] = [];
			for (const account of candidates) {
				const result = probes.get(account.accountId);
				if (result === REFRESH_FAILED || result === undefined || result.error) {
					failedCheckIds.add(account.accountId);
					continue;
				}
				if (result.limitReached) {
					if (result.resetAt !== undefined) {
						exhaustedResetAts.push(result.resetAt);
					}
					continue;
				}
				eligible.push({ account, snapshot: result });
			}

			if (eligible.length === 0) {
				break;
			}
			sawEligible = true;

			// Highest effective remaining wins; ties resolve in insertion order.
			const winner = eligible.reduce((best, candidate) =>
				(candidate.snapshot.remainingPercent ?? 100) > (best.snapshot.remainingPercent ?? 100) ? candidate : best,
			);

			const key = await this.authStorage.getOpenAICodexAccountApiKey(winner.account.accountId);
			if (!key) {
				return {
					action: "fail",
					message: `Usage limit reached; the replacement subscription's session could not be refreshed.`,
				};
			}

			// Compare-and-set under the auth file lock.
			const cas = this.authStorage.compareAndSetActiveOpenAICodexAccount(expectedActiveId, winner.account.accountId);

			if (cas?.switched) {
				this.lastKnownActiveAccountId = winner.account.accountId;
				this.emitAccountChanged(winner.account, "usage_limit");
				return { action: "retry", apiKey: key.apiKey, accountId: winner.account.accountId };
			}

			if (!cas) {
				// CAS unavailable (storage error); fall back to a plain switch.
				const selected = this.authStorage.setActiveOpenAICodexAccount(winner.account.accountId);
				if (selected) {
					this.lastKnownActiveAccountId = selected.accountId;
					this.emitAccountChanged(selected, "usage_limit");
					return { action: "retry", apiKey: key.apiKey, accountId: selected.accountId };
				}
				break;
			}

			// Another process switched first. Never adopt its choice blindly:
			// an already-attempted account would be rejected by the provider
			// (ending failover), and an exhausted/unverifiable one fails the
			// retry immediately.
			const adopted = cas.account;
			if (!attempted.has(adopted.accountId)) {
				const adoptedProbe = await this.probeAdoptedAccount(adopted, probes);
				if (adoptedProbe && !adoptedProbe.error && !adoptedProbe.limitReached) {
					const adoptedKey = await this.authStorage.getOpenAICodexAccountApiKey(adopted.accountId);
					if (adoptedKey) {
						this.lastKnownActiveAccountId = adopted.accountId;
						this.emitAccountChanged(adopted, "usage_limit");
						return { action: "retry", apiKey: adoptedKey.apiKey, accountId: adopted.accountId };
					}
				}
				if (adoptedProbe?.limitReached && adoptedProbe.resetAt !== undefined) {
					exhaustedResetAts.push(adoptedProbe.resetAt);
				}
			}

			// The externally selected account is unusable for this request:
			// exclude it and retry the CAS against current storage, from the
			// account just observed as active.
			attempted.add(adopted.accountId);
			expectedActiveId = adopted.accountId;
		}

		if (sawEligible) {
			return {
				action: "fail",
				message: "Usage limit reached; failed to switch ChatGPT subscription.",
			};
		}

		if (failedCheckIds.size > 0) {
			return {
				action: "fail",
				message: `Usage limit reached; no available subscription could be verified (${failedCheckIds.size} checks failed).`,
			};
		}

		const earliestReset = exhaustedResetAts.length > 0 ? Math.min(...exhaustedResetAts) : undefined;
		const resetSuffix =
			earliestReset !== undefined ? ` Earliest reset: ${new Date(earliestReset).toISOString()}.` : "";
		return {
			action: "fail",
			message: `All ${totalAccounts} stored ChatGPT subscriptions are out of quota.${resetSuffix}`,
		};
	}

	/**
	 * Subscribe to active-account changes (manual selection and automatic
	 * usage-limit switches). Returns an unsubscribe function.
	 */
	onAccountChanged(listener: OpenAICodexAccountChangedListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Reconcile with auth storage after an external reload (e.g. another
	 * process switched the active account or removed one). Drops cached usage
	 * for removed accounts and notifies listeners when the active account changed.
	 */
	syncFromStorage(): void {
		const snapshot = this.snapshotAccounts();
		const known = new Set(snapshot.accounts.map((account) => account.accountId));
		for (const accountId of [...this.usageCache.keys()]) {
			if (!known.has(accountId)) {
				this.usageCache.delete(accountId);
			}
		}
		const active = snapshot.accounts.find((account) => account.accountId === snapshot.activeAccountId);
		if (active && active.accountId !== this.lastKnownActiveAccountId) {
			this.lastKnownActiveAccountId = active.accountId;
			this.emitAccountChanged(active, "manual");
		} else if (!active) {
			this.lastKnownActiveAccountId = undefined;
		}
	}

	// =========================================================================
	// Internals
	// =========================================================================

	/**
	 * Current pool state, re-read under the auth file lock so other processes'
	 * writes are observed. Falls back to the in-memory cache when the locked
	 * read fails (better than declaring that no subscriptions are stored).
	 */
	private snapshotAccounts(): { accounts: OpenAICodexOAuthAccount[]; activeAccountId?: string } {
		const snapshot = this.authStorage.snapshotOpenAICodexPool();
		if (snapshot) {
			return snapshot;
		}
		return {
			accounts: this.authStorage.listOpenAICodexAccounts(),
			activeAccountId: this.authStorage.getActiveOpenAICodexAccount()?.accountId,
		};
	}

	/**
	 * Usage for an account another process selected while we were probing.
	 * Reuses our earlier probe when the account was a candidate; otherwise
	 * probes it now. Undefined when the account cannot be verified at all.
	 */
	private async probeAdoptedAccount(
		account: OpenAICodexOAuthAccount,
		probes: Map<string, ProbeResult>,
	): Promise<OpenAICodexAccountUsageSnapshot | undefined> {
		const existing = probes.get(account.accountId);
		if (existing !== undefined) {
			return existing === REFRESH_FAILED ? undefined : existing;
		}
		const fresh = await this.probeAccounts([account]);
		const result = fresh.get(account.accountId);
		if (result === undefined || result === REFRESH_FAILED) {
			return undefined;
		}
		return result;
	}

	private buildViews(snapshot?: {
		accounts: OpenAICodexOAuthAccount[];
		activeAccountId?: string;
	}): OpenAICodexAccountView[] {
		const accounts = snapshot?.accounts ?? this.authStorage.listOpenAICodexAccounts();
		const activeId = snapshot ? snapshot.activeAccountId : this.authStorage.getActiveOpenAICodexAccount()?.accountId;
		return accounts.map((account) => {
			const usage = this.usageCache.get(account.accountId);
			return {
				accountId: account.accountId,
				...(account.email !== undefined ? { email: account.email } : {}),
				label: account.label ?? account.email ?? account.accountId,
				active: account.accountId === activeId,
				...(usage ? { usage } : {}),
			};
		});
	}

	private emitAccountChanged(account: OpenAICodexOAuthAccount, reason: "manual" | "usage_limit"): void {
		const event: OpenAICodexAccountChangedEvent = {
			provider: "openai-codex",
			accountId: account.accountId,
			label: account.label ?? account.email ?? account.accountId,
			reason,
		};
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener failures must not break account switching.
			}
		}
	}

	private hasFreshUsage(accountId: string): boolean {
		const cached = this.usageCache.get(accountId);
		if (!cached) return false;
		const age = this.now() - cached.fetchedAt;
		if (cached.error) {
			return age < ERROR_TTL_MS;
		}
		return age < ENDPOINT_TTL_MS;
	}

	/**
	 * Probe usage for the given accounts with bounded concurrency.
	 * Refresh failures are marked with REFRESH_FAILED; endpoint failures come
	 * back as error snapshots (fetchOpenAICodexUsage never throws). Successful
	 * and failed probes are both written to the cache.
	 */
	private async probeAccounts(
		accounts: OpenAICodexOAuthAccount[],
		options?: { signal?: AbortSignal },
	): Promise<Map<string, ProbeResult>> {
		const results = new Map<string, ProbeResult>();
		const queue = [...accounts];
		const worker = async () => {
			while (true) {
				if (options?.signal?.aborted) return;
				const account = queue.shift();
				if (!account) return;
				const key = await this.authStorage.getOpenAICodexAccountApiKey(account.accountId);
				if (!key) {
					results.set(account.accountId, REFRESH_FAILED);
					continue;
				}
				const snapshot = await fetchOpenAICodexUsage({
					accessToken: key.apiKey,
					accountId: account.accountId,
					signal: options?.signal,
					fetchImpl: this.fetchImpl,
				});
				results.set(account.accountId, snapshot);
				this.usageCache.set(account.accountId, snapshot);
			}
		};
		const workerCount = Math.min(PROBE_CONCURRENCY, queue.length);
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type IdentityCacheEntry = { label: string; email?: string; authId?: string; refreshedAt: number };
const IDENTITY_TTL_MS = 5 * 60 * 1_000;

function readJwtSubject(token: string): string | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const normalized = part
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(part.length / 4) * 4, "=");
		const payload = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as { sub?: unknown };
		return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
	} catch {
		return undefined;
	}
}

function shortenStableId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value.length > 10 ? `${value.slice(0, 8)}…` : value;
}

function readMatchingOfficialCachedEmail(authId: string | undefined): string | undefined {
	if (!authId) return undefined;
	const override = process.env.CURSOR_AGENT_CLI_CONFIG_FILE?.trim();
	const path = override || join(homedir(), ".cursor", "cli-config.json");
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			authInfo?: { authId?: unknown; email?: unknown };
		};
		return parsed.authInfo?.authId === authId && typeof parsed.authInfo.email === "string"
			? parsed.authInfo.email
			: undefined;
	} catch {
		return undefined;
	}
}

/** Small bounded identity cache keyed by the exact active auth value fingerprint. */
export class CursorNotCloudAccountManager {
	private readonly cache = new Map<string, IdentityCacheEntry>();
	private readonly pending = new Map<
		string,
		{ promise: Promise<void>; controller: AbortController; generation: number }
	>();
	private nextGeneration = 0;
	private readonly maxEntries = 16;

	private safeLabel(value: string | undefined): string | undefined {
		if (!value) return undefined;
		const sanitized = value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
		return sanitized.length > 0 ? sanitized.slice(0, 320) : undefined;
	}

	private setCache(fingerprint: string, entry: IdentityCacheEntry): void {
		this.cache.delete(fingerprint);
		this.cache.set(fingerprint, entry);
		while (this.cache.size > this.maxEntries) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
			this.pending.get(oldest)?.controller.abort();
			this.pending.delete(oldest);
		}
	}

	observeCredential(apiKey: string, sourceToken: { valueFingerprint: string }, baseUrl?: string): void {
		const fingerprint = sourceToken.valueFingerprint;
		const existing = this.cache.get(fingerprint);
		if (existing) {
			this.setCache(fingerprint, existing);
		} else {
			const subject = this.safeLabel(readJwtSubject(apiKey));
			const cachedEmail = this.safeLabel(readMatchingOfficialCachedEmail(subject));
			this.setCache(fingerprint, {
				label: cachedEmail ?? shortenStableId(subject) ?? "Cursor subscription",
				...(cachedEmail ? { email: cachedEmail } : {}),
				...(subject ? { authId: subject } : {}),
				refreshedAt: 0,
			});
		}
		const cached = this.cache.get(fingerprint);
		if (cached?.refreshedAt && Date.now() - cached.refreshedAt < IDENTITY_TTL_MS) return;
		if (this.pending.has(fingerprint)) return;
		const controller = new AbortController();
		const generation = ++this.nextGeneration;
		const request = (async () => {
			try {
				const { fetchCursorAccountIdentity } = await import("@earendil-works/pi-ai/cursor-not-cloud");
				if (controller.signal.aborted) return;
				const identity = await fetchCursorAccountIdentity(apiKey, {
					baseUrl,
					timeoutMs: 5_000,
					signal: controller.signal,
				});
				const current = this.pending.get(fingerprint);
				if (!current || current.generation !== generation || controller.signal.aborted) return;
				const authId = this.safeLabel(identity.authId ?? readJwtSubject(apiKey));
				const email = this.safeLabel(identity.email);
				const matchingCachedEmail = this.safeLabel(readMatchingOfficialCachedEmail(authId));
				const displayEmail = email ?? matchingCachedEmail;
				this.setCache(fingerprint, {
					label: displayEmail ?? shortenStableId(authId) ?? "Cursor subscription",
					...(displayEmail ? { email: displayEmail } : {}),
					...(authId ? { authId } : {}),
					refreshedAt: Date.now(),
				});
			} catch {
				// Keep only the fingerprint-bound safe fallback; never reuse another credential's identity.
			}
		})().finally(() => {
			const current = this.pending.get(fingerprint);
			if (current?.generation === generation) this.pending.delete(fingerprint);
		});
		this.pending.set(fingerprint, { promise: request, controller, generation });
	}

	getDisplayLabel(sourceToken: { valueFingerprint: string } | undefined): string | undefined {
		if (!sourceToken) return undefined;
		const entry = this.cache.get(sourceToken.valueFingerprint);
		if (!entry) return "Cursor subscription";
		this.setCache(sourceToken.valueFingerprint, entry);
		return entry.label;
	}

	invalidate(sourceToken?: { valueFingerprint: string }): void {
		if (!sourceToken) {
			this.clear();
			return;
		}
		const fingerprint = sourceToken.valueFingerprint;
		this.pending.get(fingerprint)?.controller.abort();
		this.pending.delete(fingerprint);
		this.cache.delete(fingerprint);
	}

	clear(): void {
		for (const entry of this.pending.values()) entry.controller.abort();
		this.cache.clear();
		this.pending.clear();
	}
}

let manager: CursorNotCloudAccountManager | undefined;
export function getCursorNotCloudAccountManager(): CursorNotCloudAccountManager {
	if (!manager) manager = new CursorNotCloudAccountManager();
	return manager;
}

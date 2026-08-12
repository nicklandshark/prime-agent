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

/** Small identity cache keyed by the exact active auth value fingerprint. */
export class CursorNotCloudAccountManager {
	private readonly cache = new Map<string, IdentityCacheEntry>();
	private readonly pending = new Map<string, Promise<void>>();
	private activeFingerprint?: string;

	observeCredential(apiKey: string, sourceToken: { valueFingerprint: string }, baseUrl?: string): void {
		const fingerprint = sourceToken.valueFingerprint;
		this.activeFingerprint = fingerprint;
		if (!this.cache.has(fingerprint)) {
			const subject = readJwtSubject(apiKey);
			const cachedEmail = readMatchingOfficialCachedEmail(subject);
			this.cache.set(fingerprint, {
				label: cachedEmail ?? shortenStableId(subject) ?? "Cursor subscription",
				...(cachedEmail ? { email: cachedEmail } : {}),
				...(subject ? { authId: subject } : {}),
				refreshedAt: 0,
			});
		}
		const cached = this.cache.get(fingerprint);
		if (cached?.refreshedAt && Date.now() - cached.refreshedAt < IDENTITY_TTL_MS) return;
		if (this.pending.has(fingerprint)) return;
		const request = (async () => {
			try {
				const { fetchCursorAccountIdentity } = await import("@earendil-works/pi-ai/cursor-not-cloud");
				const identity = await fetchCursorAccountIdentity(apiKey, { baseUrl, timeoutMs: 5_000 });
				const authId = identity.authId ?? readJwtSubject(apiKey);
				const matchingCachedEmail = readMatchingOfficialCachedEmail(authId);
				this.cache.set(fingerprint, {
					label: identity.email ?? matchingCachedEmail ?? shortenStableId(authId) ?? "Cursor subscription",
					...(identity.email || matchingCachedEmail ? { email: identity.email ?? matchingCachedEmail } : {}),
					...(authId ? { authId } : {}),
					refreshedAt: Date.now(),
				});
			} catch {
				// Keep only the fingerprint-bound safe fallback; never reuse another credential's identity.
			}
		})().finally(() => this.pending.delete(fingerprint));
		this.pending.set(fingerprint, request);
	}

	getDisplayLabel(sourceToken: { valueFingerprint: string } | undefined): string | undefined {
		if (!sourceToken || sourceToken.valueFingerprint !== this.activeFingerprint) return undefined;
		return this.cache.get(sourceToken.valueFingerprint)?.label ?? "Cursor subscription";
	}

	invalidate(sourceToken?: { valueFingerprint: string }): void {
		if (sourceToken) {
			this.cache.delete(sourceToken.valueFingerprint);
			this.pending.delete(sourceToken.valueFingerprint);
			if (this.activeFingerprint === sourceToken.valueFingerprint) this.activeFingerprint = undefined;
			return;
		}
		this.activeFingerprint = undefined;
	}

	clear(): void {
		this.cache.clear();
		this.pending.clear();
		this.activeFingerprint = undefined;
	}
}

let manager: CursorNotCloudAccountManager | undefined;
export function getCursorNotCloudAccountManager(): CursorNotCloudAccountManager {
	if (!manager) manager = new CursorNotCloudAccountManager();
	return manager;
}

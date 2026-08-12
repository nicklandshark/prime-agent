/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import { createHash } from "node:crypto";
import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@earendil-works/pi-ai";
import {
	extractOpenAICodexIdentity,
	getOAuthApiKey,
	getOAuthProvider,
	getOAuthProviders,
} from "@earendil-works/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.js";
import {
	clearPrimeCliCredentials,
	getPrimeCliConfigPath,
	loadPrimeCliConfig,
	PRIME_INFERENCE_PROVIDER_ID,
	type PrimeCliConfig,
	type PrimeTeam,
	savePrimeCliApiKey,
	savePrimeCliTeamSelection,
} from "./prime-inference-auth.js";
import { resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.js";

export type PrimeTeamCredential = {
	teamId: string;
	name: string;
	slug?: string;
	role?: string;
	createdAt?: string;
};

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	primeTeam?: PrimeTeamCredential | null;
};

/**
 * One stored ChatGPT subscription. `accountId` is the ChatGPT account id from
 * the access token's "https://api.openai.com/auth" claim; legacy credentials
 * without a derivable id are keyed by a stable credential hash instead.
 */
export interface OpenAICodexOAuthAccount extends OAuthCredentials {
	accountId: string;
	email?: string;
	label?: string;
}

/**
 * Pool of stored ChatGPT subscriptions embedded beneath the provider's
 * top-level OAuth credential. The top-level access/refresh/expires/
 * accountId/email/label fields always mirror the active account so existing
 * consumers that only know `type === "oauth"` keep working.
 *
 * KNOWN RISK (accepted, documented): binaries from before the pool feature
 * discard the accountPool field when they rewrite auth.json, dropping pooled
 * accounts. Downgrading while multiple subscriptions are stored is not
 * supported.
 */
export interface OpenAICodexAccountPool {
	schemaVersion: 1;
	activeAccountId: string;
	accounts: Record<string, OpenAICodexOAuthAccount>;
}

/**
 * Point-in-time view of the openai-codex account pool, read atomically under
 * the auth file lock (see AuthStorage.snapshotOpenAICodexPool).
 */
export interface OpenAICodexPoolSnapshot {
	accounts: OpenAICodexOAuthAccount[];
	activeAccountId?: string;
}

export type OAuthCredential = {
	type: "oauth";
	accountPool?: OpenAICodexAccountPool;
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "prime_cli"
		| "fallback"
		| "models_json_key"
		| "models_json_command"
		| "stale";
	label?: string;
};

export type AuthStorageOptions = {
	primeCliConfigPath?: string;
	usePrimeCliConfig?: boolean;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

type ActiveAuthStatusSource = Exclude<NonNullable<AuthStatus["source"]>, "stale">;

export type AuthSourceToken = {
	provider: string;
	source: ActiveAuthStatusSource;
	identityFingerprint: string;
	valueFingerprint: string;
};

type AuthSourceCandidate = {
	source: ActiveAuthStatusSource;
	configured: boolean;
	label?: string;
	identityFingerprint: string;
	valueFingerprint?: string;
	resolveValueFingerprint?: () => string | undefined;
};

type AuthApiKeyResult = {
	apiKey?: string;
	sourceToken?: AuthSourceToken;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	constructor(private authPath: string = join(getAgentDir(), "auth.json")) {}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

// ============================================================================
// OpenAI Codex account pool helpers
// ============================================================================

function isValidOpenAICodexAccount(value: unknown): value is OpenAICodexOAuthAccount {
	if (!value || typeof value !== "object") return false;
	const account = value as OpenAICodexOAuthAccount;
	return (
		typeof account.accountId === "string" &&
		account.accountId.length > 0 &&
		typeof account.access === "string" &&
		typeof account.refresh === "string" &&
		typeof account.expires === "number"
	);
}

function getValidOpenAICodexPool(credential: OAuthCredential): OpenAICodexAccountPool | undefined {
	const pool = credential.accountPool;
	if (!pool || pool.schemaVersion !== 1 || !pool.accounts || typeof pool.accounts !== "object") {
		return undefined;
	}
	if (typeof pool.activeAccountId !== "string" || !isValidOpenAICodexAccount(pool.accounts[pool.activeAccountId])) {
		return undefined;
	}
	return pool;
}

/**
 * Derive the pool key for a credential: the stored/JWT account id when
 * available, otherwise a stable hash of the credential material so a legacy
 * account keeps its identity across reloads and refreshes.
 */
export function deriveOpenAICodexAccountId(credential: OAuthCredentials): string {
	if (typeof credential.accountId === "string" && credential.accountId.length > 0) {
		return credential.accountId;
	}
	const identity = extractOpenAICodexIdentity(credential.access);
	if (identity.accountId) {
		return identity.accountId;
	}
	const digest = createHash("sha256")
		.update(credential.refresh || credential.access)
		.digest("hex")
		.slice(0, 16);
	return `legacy-${digest}`;
}

function readStringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toOpenAICodexAccount(credential: OAuthCredential): OpenAICodexOAuthAccount {
	const accountId = deriveOpenAICodexAccountId(credential);
	const identity = extractOpenAICodexIdentity(credential.access);
	const account: OpenAICodexOAuthAccount = {
		...credential,
		accountId,
	};
	// Pool envelope fields belong to the outer credential, not the account.
	delete (account as { type?: unknown }).type;
	delete (account as { accountPool?: unknown }).accountPool;
	const email = readStringField(credential.email) ?? identity.email;
	if (email) account.email = email;
	else delete account.email;
	const label = readStringField(credential.label);
	if (label) account.label = label;
	else delete account.label;
	return account;
}

/** Mirror the pool's active account onto the top-level credential fields. */
function mirrorOpenAICodexActiveAccount(credential: OAuthCredential, pool: OpenAICodexAccountPool): OAuthCredential {
	const active = pool.accounts[pool.activeAccountId];
	if (!active) return credential;
	const mirrored: OAuthCredential = {
		...credential,
		access: active.access,
		refresh: active.refresh,
		expires: active.expires,
		accountId: active.accountId,
		accountPool: pool,
	};
	if (active.email !== undefined) mirrored.email = active.email;
	else delete mirrored.email;
	if (active.label !== undefined) mirrored.label = active.label;
	else delete mirrored.label;
	return mirrored;
}

/**
 * The only repair that is safe to apply to a malformed pool: re-pointing a
 * broken activeAccountId at an existing valid account. Anything else (unknown
 * schemaVersion, missing/non-object accounts map, no salvageable account) is
 * left untouched so nested credentials survive for a future reader that
 * understands the shape.
 */
function repairOpenAICodexPool(pool: unknown): OpenAICodexAccountPool | undefined {
	if (!pool || typeof pool !== "object") {
		return undefined;
	}
	const candidate = pool as OpenAICodexAccountPool;
	if (candidate.schemaVersion !== 1 || !candidate.accounts || typeof candidate.accounts !== "object") {
		return undefined;
	}
	const firstValid = Object.values(candidate.accounts).find(isValidOpenAICodexAccount);
	if (!firstValid) {
		return undefined;
	}
	return { schemaVersion: 1, activeAccountId: firstValid.accountId, accounts: candidate.accounts };
}

/**
 * Migrate a legacy single-account openai-codex credential (accountPool
 * ABSENT) into a one-account pool and repair the active-account mirror on
 * already-pooled credentials. A present-but-malformed accountPool is
 * preserved: it is only rewritten when it can be repaired without dropping
 * accounts, so a destructive single-account rebuild never wipes nested
 * refresh tokens. Returns the same object reference when no change was needed.
 */
function migrateOpenAICodexCredential(credential: OAuthCredential): { credential: OAuthCredential; migrated: boolean } {
	const existingPool = credential.accountPool !== undefined;
	const pool = getValidOpenAICodexPool(credential);
	if (!pool) {
		if (existingPool) {
			// Present but malformed: repair only when safely possible; otherwise
			// leave the credential (and its pool) completely untouched.
			const repaired = repairOpenAICodexPool(credential.accountPool);
			if (!repaired) {
				return { credential, migrated: false };
			}
			return { credential: mirrorOpenAICodexActiveAccount({ ...credential }, repaired), migrated: true };
		}
		// Legacy credential: rebuild a single fallback account from the
		// top-level fields.
		const account = toOpenAICodexAccount(credential);
		const rebuilt: OpenAICodexAccountPool = {
			schemaVersion: 1,
			activeAccountId: account.accountId,
			accounts: { [account.accountId]: account },
		};
		return { credential: mirrorOpenAICodexActiveAccount({ ...credential }, rebuilt), migrated: true };
	}
	const mirrored = mirrorOpenAICodexActiveAccount(credential, pool);
	const mirrorChanged =
		mirrored.access !== credential.access ||
		mirrored.refresh !== credential.refresh ||
		mirrored.expires !== credential.expires ||
		mirrored.accountId !== credential.accountId ||
		mirrored.email !== credential.email ||
		mirrored.label !== credential.label;
	return { credential: mirrored, migrated: !existingPool || mirrorChanged };
}

// ============================================================================
// Credential storage
// ============================================================================

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private staleAuthSources: Map<string, AuthSourceToken[]> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];

	private constructor(
		private storage: AuthStorageBackend,
		private options: AuthStorageOptions = {},
	) {
		this.reload();
	}

	static create(authPath?: string, options?: AuthStorageOptions): AuthStorage {
		const authOptions = options ?? { usePrimeCliConfig: authPath === undefined };
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")), authOptions);
	}

	static fromStorage(storage: AuthStorageBackend, options?: AuthStorageOptions): AuthStorage {
		return new AuthStorage(storage, options);
	}

	static inMemory(data: AuthStorageData = {}, options?: AuthStorageOptions): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage, options);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private fingerprintAuthSource(source: ActiveAuthStatusSource, material: string): string {
		const digest = createHash("sha256").update(source).update("\0").update(material).digest("hex");
		return `${source}:${digest}`;
	}

	private createAuthSourceCandidate(options: {
		source: ActiveAuthStatusSource;
		configured: boolean;
		identityMaterial: string;
		valueMaterial?: string;
		label?: string;
		resolveValueMaterial?: () => string | undefined;
	}): AuthSourceCandidate {
		return {
			configured: options.configured,
			source: options.source,
			...(options.label ? { label: options.label } : {}),
			identityFingerprint: this.fingerprintAuthSource(options.source, `identity:${options.identityMaterial}`),
			...(options.valueMaterial !== undefined
				? {
						valueFingerprint: this.fingerprintAuthSource(
							options.source,
							`value:${options.identityMaterial}\0${options.valueMaterial}`,
						),
					}
				: {}),
			...(options.resolveValueMaterial
				? {
						resolveValueFingerprint: () => {
							const valueMaterial = options.resolveValueMaterial?.();
							return valueMaterial === undefined
								? undefined
								: this.fingerprintAuthSource(
										options.source,
										`value:${options.identityMaterial}\0${valueMaterial}`,
									);
						},
					}
				: {}),
		};
	}

	private getStoredCredentialValueMaterial(providerId: string, credential: AuthCredential): string | undefined {
		if (credential.type === "api_key") {
			if (credential.key.startsWith("!")) {
				const resolvedKey = resolveConfigValueUncached(credential.key);
				return resolvedKey === undefined ? undefined : `api_key:command:${credential.key}\0${resolvedKey}`;
			}
			return `api_key:${credential.key}\0${resolveConfigValue(credential.key) ?? ""}`;
		}
		const provider = getOAuthProvider(providerId);
		const apiKey = provider?.getApiKey(credential) ?? credential.access;
		return `oauth:${apiKey}\0${credential.refresh}\0${credential.expires}`;
	}

	private getRuntimeAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.runtimeOverrides.get(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "--api-key",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "runtime",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getPrimeCliAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.getPrimeCliApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "Prime CLI",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "prime_cli",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getStoredAuthCandidate(
		provider: string,
		options?: { resolveCommandValue?: boolean; resolvedCommandValue?: string },
	): AuthSourceCandidate | undefined {
		const credential = this.data[provider];
		if (!credential) {
			return undefined;
		}
		const isCommandApiKey = credential.type === "api_key" && credential.key.startsWith("!");
		let identityMaterial = isCommandApiKey ? `api_key:command:${credential.key}` : `${provider}:${credential.type}`;
		if (provider === OPENAI_CODEX_PROVIDER_ID && credential.type === "oauth") {
			// Staleness is per-account: marking one pooled account stale must not
			// poison the credential identity of the other stored accounts.
			const accountId =
				credential.accountPool?.activeAccountId ?? readStringField(credential.accountId) ?? undefined;
			if (accountId) {
				identityMaterial += `:${accountId}`;
			}
		}
		const commandValueMaterial =
			isCommandApiKey && options?.resolvedCommandValue !== undefined
				? `api_key:command:${credential.key}\0${options.resolvedCommandValue}`
				: undefined;
		return this.createAuthSourceCandidate({
			configured: true,
			source: "stored",
			identityMaterial,
			valueMaterial:
				commandValueMaterial ??
				(isCommandApiKey && !options?.resolveCommandValue
					? undefined
					: this.getStoredCredentialValueMaterial(provider, credential)),
			resolveValueMaterial: isCommandApiKey
				? () => this.getStoredCredentialValueMaterial(provider, credential)
				: undefined,
		});
	}

	private getEnvironmentAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const envKeys = findEnvKeys(provider);
		const envKey = envKeys?.[0];
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		const label = envKey ?? "ambient credentials";
		const identityMaterial = envKey ?? this.getAmbientEnvironmentIdentityMaterial(provider);
		return this.createAuthSourceCandidate({
			configured: false,
			source: "environment",
			label,
			identityMaterial,
			valueMaterial: `${identityMaterial}\0${apiKey}`,
		});
	}

	private getAmbientEnvironmentIdentityMaterial(provider: string): string {
		if (provider === "amazon-bedrock") {
			if (process.env.AWS_PROFILE) return `amazon-bedrock:profile:${process.env.AWS_PROFILE}`;
			if (process.env.AWS_ACCESS_KEY_ID) {
				return `amazon-bedrock:access-key:${process.env.AWS_ACCESS_KEY_ID}:${process.env.AWS_SECRET_ACCESS_KEY ?? ""}:${process.env.AWS_SESSION_TOKEN ?? ""}`;
			}
			if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
				return `amazon-bedrock:bearer:${process.env.AWS_BEARER_TOKEN_BEDROCK}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
				return `amazon-bedrock:ecs-relative:${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
				return `amazon-bedrock:ecs-full:${process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI}`;
			}
			if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
				return `amazon-bedrock:web-identity:${process.env.AWS_WEB_IDENTITY_TOKEN_FILE}`;
			}
		}
		if (provider === "google-vertex") {
			const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
			const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";
			const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "application-default";
			return `google-vertex:${project}:${location}:${credentialsPath}`;
		}
		return provider;
	}

	private getFallbackAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.fallbackResolver?.(provider);
		if (!apiKey) {
			return undefined;
		}
		return this.createAuthSourceCandidate({
			configured: false,
			source: "fallback",
			label: "custom provider config",
			identityMaterial: provider,
			valueMaterial: apiKey,
		});
	}

	private getAuthSourceCandidates(provider: string, options?: { includeFallback?: boolean }): AuthSourceCandidate[] {
		const fallbackCandidate =
			options?.includeFallback === false ? undefined : this.getFallbackAuthCandidate(provider);
		const candidates =
			provider === PRIME_INFERENCE_PROVIDER_ID
				? [
						this.getRuntimeAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						this.getPrimeCliAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						fallbackCandidate,
					]
				: [
						this.getRuntimeAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						fallbackCandidate,
					];
		return candidates.filter((candidate): candidate is AuthSourceCandidate => candidate !== undefined);
	}

	private isAuthSourceStale(provider: string, candidate: AuthSourceCandidate): boolean {
		const matchingStale = this.getMatchingStaleAuthSources(provider, candidate);
		if (matchingStale.length === 0) {
			return false;
		}
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		return Boolean(valueFingerprint && matchingStale.some((token) => token.valueFingerprint === valueFingerprint));
	}

	private getMatchingStaleAuthSources(provider: string, candidate: AuthSourceCandidate): AuthSourceToken[] {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return [];
		}
		return stale.filter(
			(token) => token.source === candidate.source && token.identityFingerprint === candidate.identityFingerprint,
		);
	}

	private getAvailableAuthCandidate(
		provider: string,
		options?: { includeFallback?: boolean },
	): { candidate?: AuthSourceCandidate; hasStaleCandidate: boolean } {
		let hasStaleCandidate = false;
		for (const candidate of this.getAuthSourceCandidates(provider, options)) {
			if (this.isAuthSourceStale(provider, candidate)) {
				hasStaleCandidate = true;
				continue;
			}
			return { candidate, hasStaleCandidate };
		}
		return { hasStaleCandidate };
	}

	private toAuthStatus(candidate: AuthSourceCandidate): AuthStatus {
		return {
			configured: candidate.configured,
			source: candidate.source,
			...(candidate.label ? { label: candidate.label } : {}),
		};
	}

	private getAuthStatusFromCandidates(provider: string): AuthStatus {
		const { candidate, hasStaleCandidate } = this.getAvailableAuthCandidate(provider);
		if (candidate) {
			return this.toAuthStatus(candidate);
		}
		if (hasStaleCandidate) {
			return { configured: false, source: "stale", label: "expired" };
		}
		return { configured: false };
	}

	markAuthStale(provider: string): boolean {
		const token = this.getCurrentAuthSourceToken(provider);
		return token ? this.markAuthSourceStale(token) : false;
	}

	private getAuthSourceTokenForCandidate(
		provider: string,
		candidate: AuthSourceCandidate,
	): AuthSourceToken | undefined {
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		if (!valueFingerprint) {
			return undefined;
		}
		return {
			provider,
			source: candidate.source,
			identityFingerprint: candidate.identityFingerprint,
			valueFingerprint,
		};
	}

	getCurrentAuthSourceToken(provider: string): AuthSourceToken | undefined {
		const { candidate } = this.getAvailableAuthCandidate(provider);
		if (!candidate) {
			return undefined;
		}
		return this.getAuthSourceTokenForCandidate(provider, candidate);
	}

	markAuthSourceStale(token: AuthSourceToken): boolean {
		if (token.provider.length === 0) {
			return false;
		}
		const stale = this.staleAuthSources.get(token.provider) ?? [];
		if (
			!stale.some(
				(existing) =>
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			stale.push(token);
		}
		this.staleAuthSources.set(token.provider, stale);
		return true;
	}

	private clearStaleAuthSource(provider: string, source: ActiveAuthStatusSource): void {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return;
		}
		const next = stale.filter((token) => token.source !== source);
		if (next.length === 0) {
			this.staleAuthSources.delete(provider);
		} else {
			this.staleAuthSources.set(provider, next);
		}
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		return this.parseStorageDataMigrating(content).data;
	}

	/**
	 * Parse the stored payload, migrating legacy single-account openai-codex
	 * credentials into a one-account pool. Pure aside from the migration flag;
	 * callers persist `data` under the lock they already hold when `migrated`.
	 */
	private parseStorageDataMigrating(content: string | undefined): { data: AuthStorageData; migrated: boolean } {
		if (!content) {
			return { data: {}, migrated: false };
		}
		const parsed = JSON.parse(content) as AuthStorageData;
		let migrated = false;
		for (const [provider, credential] of Object.entries(parsed)) {
			if (provider !== OPENAI_CODEX_PROVIDER_ID || credential?.type !== "oauth") {
				continue;
			}
			const result = migrateOpenAICodexCredential(credential);
			if (result.migrated) {
				parsed[provider] = result.credential;
				migrated = true;
			}
		}
		return { data: parsed, migrated };
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		try {
			this.storage.withLock((current) => {
				const { data, migrated } = this.parseStorageDataMigrating(current);
				this.data = data;
				// Persist the pool migration under the same lock so subsequent
				// readers (including other processes) see the canonical shape.
				return { result: undefined, next: migrated ? JSON.stringify(data, null, 2) : undefined };
			});
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 *
	 * For openai-codex, an unpooled OAuth credential upserts into the existing
	 * account pool (keyed by account id) instead of replacing it, so direct
	 * callers cannot silently drop other stored accounts.
	 */
	set(provider: string, credential: AuthCredential): void {
		if (
			provider === OPENAI_CODEX_PROVIDER_ID &&
			credential.type === "oauth" &&
			credential.accountPool === undefined
		) {
			const existing = this.getOpenAICodexPoolFromData(this.data);
			if (existing) {
				this.upsertOpenAICodexAccount(credential);
				return;
			}
		}
		this.clearStaleAuthSource(provider, "stored");
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.clearStaleAuthSource(provider, "stored");
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		return this.getAvailableAuthCandidate(provider).candidate !== undefined;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		return this.getAuthStatusFromCandidates(provider);
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 *
	 * For openai-codex the new account is upserted into the stored account pool
	 * (keyed by ChatGPT account id) instead of replacing the credential, so
	 * re-login or adding a second subscription preserves the other accounts.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		if (providerId === OPENAI_CODEX_PROVIDER_ID) {
			this.upsertOpenAICodexAccount(credentials);
			return;
		}
		this.set(providerId, { type: "oauth", ...credentials });
	}

	// =========================================================================
	// OpenAI Codex account pool
	// =========================================================================

	private getOpenAICodexPoolFromData(
		data: AuthStorageData,
	): { credential: OAuthCredential; pool: OpenAICodexAccountPool } | undefined {
		const credential = data[OPENAI_CODEX_PROVIDER_ID];
		if (credential?.type !== "oauth") {
			return undefined;
		}
		// data has been through parseStorageData, so legacy credentials are
		// migrated and salvageable pools are repaired.
		const pool = getValidOpenAICodexPool(credential);
		if (pool) {
			return { credential, pool };
		}
		if (credential.accountPool !== undefined) {
			// The pool is present but malformed and unsalvageable. It is
			// deliberately left untouched on disk; for reads, fall back to the
			// top-level mirror as a synthesized single-account pool (never
			// persisted — write paths operate on the validated on-disk pool).
			const mirror = toOpenAICodexAccount(credential);
			if (!isValidOpenAICodexAccount(mirror)) {
				return undefined;
			}
			return {
				credential,
				pool: { schemaVersion: 1, activeAccountId: mirror.accountId, accounts: { [mirror.accountId]: mirror } },
			};
		}
		return undefined;
	}

	/**
	 * List all stored ChatGPT subscription accounts (pool order = insertion order).
	 */
	listOpenAICodexAccounts(): OpenAICodexOAuthAccount[] {
		const entry = this.getOpenAICodexPoolFromData(this.data);
		if (!entry) {
			return [];
		}
		return Object.values(entry.pool.accounts).filter(isValidOpenAICodexAccount);
	}

	/**
	 * Atomically re-read auth.json under the file lock and return the current
	 * openai-codex pool (accounts + active account id). Unlike the cached
	 * getters, this observes writes made by other processes, so multi-daemon
	 * failover lists/probes the subscriptions that are stored NOW. The
	 * in-memory cache is refreshed as a side effect. Returns undefined when
	 * storage cannot be read; callers should fall back to the cached getters.
	 */
	snapshotOpenAICodexPool(): OpenAICodexPoolSnapshot | undefined {
		try {
			return this.storage.withLock((current) => {
				const { data, migrated } = this.parseStorageDataMigrating(current);
				this.data = data;
				this.loadError = null;
				const entry = this.getOpenAICodexPoolFromData(data);
				const snapshot: OpenAICodexPoolSnapshot = entry
					? {
							accounts: Object.values(entry.pool.accounts).filter(isValidOpenAICodexAccount),
							...(entry.pool.activeAccountId !== undefined
								? { activeAccountId: entry.pool.activeAccountId }
								: {}),
						}
					: { accounts: [] };
				return { result: snapshot, next: migrated ? JSON.stringify(data, null, 2) : undefined };
			});
		} catch (error) {
			this.recordError(error);
			return undefined;
		}
	}

	/**
	 * The currently active ChatGPT subscription account.
	 */
	getActiveOpenAICodexAccount(): OpenAICodexOAuthAccount | undefined {
		const entry = this.getOpenAICodexPoolFromData(this.data);
		if (!entry) {
			return undefined;
		}
		return entry.pool.accounts[entry.pool.activeAccountId];
	}

	/**
	 * Upsert an account into the openai-codex pool and make it active.
	 * Existing metadata (label, email) is preserved when the incoming
	 * credentials don't carry it.
	 */
	upsertOpenAICodexAccount(credentials: OAuthCredentials): OpenAICodexOAuthAccount {
		const incoming = toOpenAICodexAccount({ type: "oauth", ...credentials });
		try {
			const stored = this.storage.withLock((current) => {
				const { data } = this.parseStorageDataMigrating(current);
				const existing = data[OPENAI_CODEX_PROVIDER_ID];
				const existingPool = existing?.type === "oauth" ? getValidOpenAICodexPool(existing) : undefined;
				if (existing?.type === "oauth" && existing.accountPool !== undefined && !existingPool) {
					// The stored pool is malformed and could not be safely repaired.
					// Refuse to replace it: upserting would silently drop the nested
					// accounts it still holds.
					throw new Error(
						"Refusing to update the openai-codex account pool: the stored pool is malformed. Repair or remove it in auth.json first.",
					);
				}
				const previous = existingPool?.accounts[incoming.accountId];
				const account: OpenAICodexOAuthAccount = {
					...previous,
					...incoming,
					accountId: incoming.accountId,
				};
				const email = incoming.email ?? previous?.email;
				if (email) account.email = email;
				else delete account.email;
				const label = incoming.label ?? previous?.label;
				if (label) account.label = label;
				else delete account.label;

				const pool: OpenAICodexAccountPool = existingPool
					? {
							schemaVersion: 1,
							activeAccountId: incoming.accountId,
							accounts: { ...existingPool.accounts, [incoming.accountId]: account },
						}
					: { schemaVersion: 1, activeAccountId: incoming.accountId, accounts: { [incoming.accountId]: account } };
				const base: OAuthCredential =
					existing?.type === "oauth" ? existing : ({ type: "oauth", ...credentials } as OAuthCredential);
				const nextCredential = mirrorOpenAICodexActiveAccount({ ...base, type: "oauth" }, pool);
				const merged: AuthStorageData = { ...data, [OPENAI_CODEX_PROVIDER_ID]: nextCredential };
				this.data = merged;
				return { result: account, next: JSON.stringify(merged, null, 2) };
			});
			this.clearStaleAuthSource(OPENAI_CODEX_PROVIDER_ID, "stored");
			return stored;
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	/**
	 * Switch the active ChatGPT subscription account. Returns the activated
	 * account, or undefined when the account is unknown or storage fails.
	 */
	setActiveOpenAICodexAccount(accountId: string): OpenAICodexOAuthAccount | undefined {
		return this.switchOpenAICodexAccount({ nextAccountId: accountId })?.account;
	}

	/**
	 * Compare-and-set the active account under the auth file lock. When the
	 * current active account no longer equals `expectedAccountId`, another
	 * process already switched; the current active account is returned with
	 * `switched: false` and no write is made.
	 */
	compareAndSetActiveOpenAICodexAccount(
		expectedAccountId: string,
		nextAccountId: string,
	): { account: OpenAICodexOAuthAccount; switched: boolean } | undefined {
		return this.switchOpenAICodexAccount({ nextAccountId, expectedAccountId });
	}

	private switchOpenAICodexAccount(args: {
		nextAccountId: string;
		expectedAccountId?: string;
	}): { account: OpenAICodexOAuthAccount; switched: boolean } | undefined {
		type SwitchResult = { account: OpenAICodexOAuthAccount; switched: boolean } | undefined;
		try {
			return this.storage.withLock((current): LockResult<SwitchResult> => {
				const { data, migrated } = this.parseStorageDataMigrating(current);
				const credential = data[OPENAI_CODEX_PROVIDER_ID];
				if (credential?.type !== "oauth") {
					return { result: undefined };
				}
				const pool = getValidOpenAICodexPool(credential);
				if (!pool) {
					return { result: undefined };
				}

				if (args.expectedAccountId !== undefined && pool.activeAccountId !== args.expectedAccountId) {
					const current_active = pool.accounts[pool.activeAccountId];
					if (!current_active) {
						return { result: undefined };
					}
					if (migrated) {
						this.data = data;
					}
					return {
						result: { account: current_active, switched: false },
						next: migrated ? JSON.stringify(data, null, 2) : undefined,
					};
				}

				const nextAccount = pool.accounts[args.nextAccountId];
				if (!nextAccount) {
					return { result: undefined };
				}
				if (pool.activeAccountId === args.nextAccountId && !migrated) {
					this.data = data;
					return { result: { account: nextAccount, switched: true } };
				}

				const nextPool: OpenAICodexAccountPool = { ...pool, activeAccountId: args.nextAccountId };
				const nextCredential = mirrorOpenAICodexActiveAccount({ ...credential }, nextPool);
				const merged: AuthStorageData = { ...data, [OPENAI_CODEX_PROVIDER_ID]: nextCredential };
				this.data = merged;
				this.clearStaleAuthSource(OPENAI_CODEX_PROVIDER_ID, "stored");
				return { result: { account: nextAccount, switched: true }, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
			return undefined;
		}
	}

	/**
	 * Resolve a usable access token for a specific pooled account, refreshing
	 * it under the auth file lock when expired. Only the matching account is
	 * updated; other accounts and their email/label metadata are preserved.
	 * Returns undefined when the account is unknown or refresh fails.
	 */
	async getOpenAICodexAccountApiKey(
		accountId: string,
	): Promise<{ apiKey: string; account: OpenAICodexOAuthAccount } | undefined> {
		const provider = getOAuthProvider(OPENAI_CODEX_PROVIDER_ID);
		if (!provider) {
			return undefined;
		}
		try {
			const result = await this.storage.withLockAsync(async (current) => {
				const { data } = this.parseStorageDataMigrating(current);
				this.data = data;
				this.loadError = null;

				const credential = data[OPENAI_CODEX_PROVIDER_ID];
				if (credential?.type !== "oauth") {
					return { result: null };
				}
				const pool = getValidOpenAICodexPool(credential);
				if (!pool) {
					// Malformed pool (present but unsalvageable): serve the
					// top-level mirror while it is unexpired, but never refresh —
					// the rotated tokens could not be persisted back into the
					// broken pool and the account would be lost.
					if (credential.accountPool !== undefined) {
						const mirror = toOpenAICodexAccount(credential);
						if (
							isValidOpenAICodexAccount(mirror) &&
							mirror.accountId === accountId &&
							Date.now() < mirror.expires
						) {
							return { result: { apiKey: provider.getApiKey(mirror), account: mirror } };
						}
					}
					return { result: null };
				}
				const account = pool.accounts[accountId];
				if (!account) {
					return { result: null };
				}

				if (Date.now() < account.expires) {
					// Best-effort email backfill for accounts stored before the email
					// claim was reliably decoded: persist it on next successful use
					// so the UI can label the account by email.
					if (account.email === undefined) {
						const identityEmail = extractOpenAICodexIdentity(account.access).email;
						if (identityEmail) {
							const backfilled: OpenAICodexOAuthAccount = { ...account, email: identityEmail };
							const backfillPool: OpenAICodexAccountPool = {
								...pool,
								accounts: { ...pool.accounts, [accountId]: backfilled },
							};
							const backfillCredential = mirrorOpenAICodexActiveAccount({ ...credential }, backfillPool);
							const backfillMerged: AuthStorageData = {
								...data,
								[OPENAI_CODEX_PROVIDER_ID]: backfillCredential,
							};
							this.data = backfillMerged;
							return {
								result: { apiKey: provider.getApiKey(backfilled), account: backfilled },
								next: JSON.stringify(backfillMerged, null, 2),
							};
						}
					}
					return { result: { apiKey: provider.getApiKey(account), account } };
				}

				const refreshed = await provider.refreshToken(account);
				const nextAccount: OpenAICodexOAuthAccount = {
					...account,
					...refreshed,
					accountId: account.accountId,
				};
				const email = readStringField(refreshed.email) ?? account.email;
				if (email) nextAccount.email = email;
				else delete nextAccount.email;
				if (account.label !== undefined) nextAccount.label = account.label;

				const nextPool: OpenAICodexAccountPool = {
					...pool,
					accounts: { ...pool.accounts, [accountId]: nextAccount },
				};
				const nextCredential = mirrorOpenAICodexActiveAccount({ ...credential }, nextPool);
				const merged: AuthStorageData = { ...data, [OPENAI_CODEX_PROVIDER_ID]: nextCredential };
				this.data = merged;
				this.loadError = null;
				return {
					result: { apiKey: provider.getApiKey(nextAccount), account: nextAccount },
					next: JSON.stringify(merged, null, 2),
				};
			});
			return result ?? undefined;
		} catch (error) {
			this.recordError(error);
			// Re-read in case another instance refreshed successfully.
			this.reload();
			const account = this.getOpenAICodexPoolFromData(this.data)?.pool.accounts[accountId];
			if (account && Date.now() < account.expires) {
				return { apiKey: provider.getApiKey(account), account };
			}
			return undefined;
		}
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		if (provider === PRIME_INFERENCE_PROVIDER_ID && this.isPrimeCliConfigEnabled()) {
			try {
				clearPrimeCliCredentials(this.getEnabledPrimeCliConfigPath());
				this.clearStaleAuthSource(provider, "prime_cli");
			} catch (error) {
				this.recordError(error);
				throw error;
			}
		}
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
		force = false,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (providerId === OPENAI_CODEX_PROVIDER_ID) {
				// Pool-aware refresh: only the active account is refreshed; other
				// accounts and their email/label metadata are preserved.
				const pool = getValidOpenAICodexPool(cred);
				const active = pool?.accounts[pool.activeAccountId];
				if (!pool || !active) {
					return { result: null };
				}
				if (!force && Date.now() < active.expires) {
					return { result: { apiKey: provider.getApiKey(active), newCredentials: active } };
				}
				const refreshedCredentials = await provider.refreshToken(active);
				const nextAccount: OpenAICodexOAuthAccount = {
					...active,
					...refreshedCredentials,
					accountId: active.accountId,
				};
				const email = readStringField(refreshedCredentials.email) ?? active.email;
				if (email) nextAccount.email = email;
				else delete nextAccount.email;
				if (active.label !== undefined) nextAccount.label = active.label;
				const nextPool: OpenAICodexAccountPool = {
					...pool,
					accounts: { ...pool.accounts, [active.accountId]: nextAccount },
				};
				const nextCredential = mirrorOpenAICodexActiveAccount({ ...cred }, nextPool);
				const pooledMerge: AuthStorageData = { ...currentData, [providerId]: nextCredential };
				this.data = pooledMerge;
				this.loadError = null;
				return {
					result: { apiKey: provider.getApiKey(nextAccount), newCredentials: nextAccount },
					next: JSON.stringify(pooledMerge, null, 2),
				};
			}

			if (!force && Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/** Force a file-locked OAuth source re-read after a concrete provider 401/403. */
	async forceRefreshOAuthToken(providerId: OAuthProviderId): Promise<string | undefined> {
		const result = await this.refreshOAuthTokenWithLock(providerId, true);
		return result?.apiKey;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. Prime Inference: environment variable, Prime CLI config, auth.json
	 * 3. Other providers: auth.json, environment variable
	 * 4. Fallback resolver (models.json custom providers)
	 */
	async getApiKeyWithSourceToken(
		providerId: string,
		options?: { includeFallback?: boolean },
	): Promise<AuthApiKeyResult> {
		// Runtime override takes highest priority
		const runtimeCandidate = this.getRuntimeAuthCandidate(providerId);
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey && runtimeCandidate && !this.isAuthSourceStale(providerId, runtimeCandidate)) {
			return {
				apiKey: runtimeKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, runtimeCandidate),
			};
		}

		const envCandidate = this.getEnvironmentAuthCandidate(providerId);
		const envKey = getEnvApiKey(providerId);
		if (
			providerId === PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return {
				apiKey: envKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
			};
		}

		if (providerId === PRIME_INFERENCE_PROVIDER_ID) {
			const primeCliCandidate = this.getPrimeCliAuthCandidate(providerId);
			const primeCliKey = this.getPrimeCliApiKey(providerId);
			if (primeCliKey && primeCliCandidate && !this.isAuthSourceStale(providerId, primeCliCandidate)) {
				return {
					apiKey: primeCliKey,
					sourceToken: this.getAuthSourceTokenForCandidate(providerId, primeCliCandidate),
				};
			}
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				const hasStaleRecord = this.getMatchingStaleAuthSources(providerId, storedCandidate).length > 0;
				const apiKey =
					cred.key.startsWith("!") && hasStaleRecord
						? resolveConfigValueUncached(cred.key)
						: resolveConfigValue(cred.key);
				const sourceToken =
					apiKey === undefined
						? undefined
						: this.getAuthSourceTokenForCandidate(
								providerId,
								cred.key.startsWith("!")
									? (this.getStoredAuthCandidate(providerId, { resolvedCommandValue: apiKey }) ??
											storedCandidate)
									: storedCandidate,
							);
				return { apiKey, sourceToken };
			}
		}

		if (cred?.type === "oauth") {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				const provider = getOAuthProvider(providerId);
				if (!provider) {
					// Unknown OAuth provider, can't get API key
					return {};
				}

				// Check if token needs refresh
				const needsRefresh = Date.now() >= cred.expires;

				if (needsRefresh) {
					// Use locked refresh to prevent race conditions
					try {
						const result = await this.refreshOAuthTokenWithLock(providerId);
						if (result) {
							const refreshedCandidate = this.getStoredAuthCandidate(providerId);
							return {
								apiKey: result.apiKey,
								sourceToken: refreshedCandidate
									? this.getAuthSourceTokenForCandidate(providerId, refreshedCandidate)
									: undefined,
							};
						}
					} catch (error) {
						this.recordError(error);
						// Refresh failed - re-read file to check if another instance succeeded
						this.reload();
						const updatedCred = this.data[providerId];

						if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
							// Another instance refreshed successfully, use those credentials
							const updatedCandidate = this.getStoredAuthCandidate(providerId);
							return {
								apiKey: provider.getApiKey(updatedCred),
								sourceToken: updatedCandidate
									? this.getAuthSourceTokenForCandidate(providerId, updatedCandidate)
									: undefined,
							};
						}

						// Refresh truly failed - return undefined so model discovery skips this provider
						// User can /login to re-authenticate (credentials preserved for retry)
						return {};
					}
				} else {
					// Token not expired, use current access token
					return {
						apiKey: provider.getApiKey(cred),
						sourceToken: this.getAuthSourceTokenForCandidate(providerId, storedCandidate),
					};
				}
			}
		}

		// Other providers preserve auth.json priority over environment variables.
		if (
			providerId !== PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return {
				apiKey: envKey,
				sourceToken: this.getAuthSourceTokenForCandidate(providerId, envCandidate),
			};
		}

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			const fallbackCandidate = this.getFallbackAuthCandidate(providerId);
			if (fallbackCandidate && !this.isAuthSourceStale(providerId, fallbackCandidate)) {
				return {
					apiKey: this.fallbackResolver?.(providerId) ?? undefined,
					sourceToken: this.getAuthSourceTokenForCandidate(providerId, fallbackCandidate),
				};
			}
		}

		return {};
	}

	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		const result = await this.getApiKeyWithSourceToken(providerId, options);
		return result.apiKey;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}

	setPrimeInferenceTeamSelection(team: PrimeTeam | null): void {
		if (this.isPrimeCliConfigEnabled()) {
			try {
				savePrimeCliTeamSelection(team, this.getEnabledPrimeCliConfigPath());
			} catch (error) {
				this.recordError(error);
				throw error;
			}
			return;
		}

		const credential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		if (credential?.type !== "api_key") {
			return;
		}
		this.set(PRIME_INFERENCE_PROVIDER_ID, {
			...credential,
			primeTeam: team ? this.toPrimeTeamCredential(team) : null,
		});
	}

	setPrimeInferenceApiKey(apiKey: string): void {
		if (this.isPrimeCliConfigEnabled()) {
			try {
				const configPath = this.getEnabledPrimeCliConfigPath();
				const config = loadPrimeCliConfig(configPath);
				const existingCredential = this.data[PRIME_INFERENCE_PROVIDER_ID];
				const legacyPrimeTeam = existingCredential?.type === "api_key" ? existingCredential.primeTeam : undefined;
				if (config.apiKey !== apiKey) {
					savePrimeCliApiKey(apiKey, configPath);
				} else if (!config.teamIdFromEnv && (legacyPrimeTeam === null || (!config.teamId && legacyPrimeTeam))) {
					savePrimeCliTeamSelection(legacyPrimeTeam, configPath);
				}
				this.clearStaleAuthSource(PRIME_INFERENCE_PROVIDER_ID, "prime_cli");
			} catch (error) {
				this.recordError(error);
				throw error;
			}
			if (this.data[PRIME_INFERENCE_PROVIDER_ID]) {
				this.remove(PRIME_INFERENCE_PROVIDER_ID);
			}
			return;
		}

		const existingCredential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		const existingPrimeTeam = existingCredential?.type === "api_key" ? existingCredential.primeTeam : undefined;
		this.set(PRIME_INFERENCE_PROVIDER_ID, {
			type: "api_key",
			key: apiKey,
			...(existingPrimeTeam !== undefined ? { primeTeam: existingPrimeTeam } : {}),
		});
	}

	getPrimeInferenceTeamSelection(): PrimeTeamCredential | null | undefined {
		let config: PrimeCliConfig | undefined;
		if (this.isPrimeCliConfigEnabled()) {
			config = this.getPrimeCliConfig(PRIME_INFERENCE_PROVIDER_ID);
			if (config?.teamIdFromEnv) {
				return undefined;
			}
		}

		const credential = this.data[PRIME_INFERENCE_PROVIDER_ID];
		const authSource = this.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID).source;
		if (authSource === "runtime" || authSource === "environment") {
			return undefined;
		}
		if (authSource === "prime_cli") {
			if (credential?.type === "api_key" && credential.primeTeam === null) {
				return null;
			}
			if (config?.teamId) {
				return this.toPrimeTeamCredential({
					teamId: config.teamId,
					name: config.teamName ?? "Prime CLI team",
					...(config.teamRole ? { role: config.teamRole } : {}),
				});
			}
			if (credential?.type === "api_key" && credential.primeTeam) {
				return credential.primeTeam;
			}
			return null;
		}
		if (credential?.type === "api_key" && credential.primeTeam !== undefined) {
			return credential.primeTeam;
		}
		if (!config?.apiKey && config?.teamId) {
			return this.toPrimeTeamCredential({
				teamId: config.teamId,
				name: config.teamName ?? "Prime CLI team",
				...(config.teamRole ? { role: config.teamRole } : {}),
			});
		}
		return undefined;
	}

	getProviderHeaders(providerId: string): Record<string, string> | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}

		const primeCliConfig = this.getPrimeCliConfig(providerId);
		if (primeCliConfig?.teamIdFromEnv) {
			return primeCliConfig.teamId ? { "X-Prime-Team-ID": primeCliConfig.teamId } : undefined;
		}

		const teamId = this.getPrimeInferenceTeamSelection()?.teamId;
		return teamId ? { "X-Prime-Team-ID": teamId } : undefined;
	}

	getPrimeCliConfigPath(): string | undefined {
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return getPrimeCliConfigPath(this.options.primeCliConfigPath);
	}

	private toPrimeTeamCredential(team: PrimeTeam): PrimeTeamCredential {
		const credential: PrimeTeamCredential = {
			teamId: team.teamId,
			name: team.name,
		};
		if (team.slug) {
			credential.slug = team.slug;
		}
		if (team.role) {
			credential.role = team.role;
		}
		if (team.createdAt) {
			credential.createdAt = team.createdAt;
		}
		return credential;
	}

	private getPrimeCliConfig(providerId: string): PrimeCliConfig | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return loadPrimeCliConfig(this.options.primeCliConfigPath);
	}

	private getPrimeCliApiKey(providerId: string): string | undefined {
		return this.getPrimeCliConfig(providerId)?.apiKey;
	}

	private getEnabledPrimeCliConfigPath(): string {
		const configPath = this.getPrimeCliConfigPath();
		if (!configPath) {
			throw new Error("Prime CLI config is not enabled");
		}
		return configPath;
	}

	private isPrimeCliConfigEnabled(): boolean {
		return Boolean(this.options.usePrimeCliConfig || this.options.primeCliConfigPath);
	}
}

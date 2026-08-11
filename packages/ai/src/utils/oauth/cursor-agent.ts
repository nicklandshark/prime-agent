import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_API_KEY_EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 10_000;
const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1_000;

type CursorCredentialFile = {
	accessToken?: unknown;
	refreshToken?: unknown;
};

function officialCursorAuthPath(): string {
	const override = process.env.CURSOR_AGENT_AUTH_FILE?.trim();
	if (override) return override;
	if (process.platform === "win32") {
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Cursor", "auth.json");
	}
	return join(homedir(), ".config", "cursor", "auth.json");
}

function tokenExpiresAt(token: string): number {
	try {
		const payload = token.split(".")[1];
		if (!payload) return Date.now() + 60 * 60 * 1_000;
		const normalized = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as { exp?: unknown };
		if (typeof parsed.exp === "number" && Number.isFinite(parsed.exp)) {
			return parsed.exp * 1_000 - TOKEN_EXPIRY_SKEW_MS;
		}
	} catch {
		// Opaque tokens receive a conservative one-hour lifetime.
	}
	return Date.now() + 60 * 60 * 1_000;
}

function officialJwtExpiresAt(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined;
	try {
		const normalized = parts[1]
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		const parsed = JSON.parse(Buffer.from(normalized, "base64").toString("utf8")) as { exp?: unknown };
		if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return undefined;
		return parsed.exp * 1_000 - TOKEN_EXPIRY_SKEW_MS;
	} catch {
		return undefined;
	}
}

function readOfficialCursorCredentials(): OAuthCredentials | undefined {
	const path = officialCursorAuthPath();
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CursorCredentialFile;
		if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) return undefined;
		const expires = officialJwtExpiresAt(parsed.accessToken);
		if (expires === undefined || expires <= Date.now()) return undefined;
		return {
			access: parsed.accessToken,
			// The official store owns token rotation. Never copy its refresh token
			// into Prime's auth.json or infer an undocumented exchange protocol.
			refresh: "",
			expires,
			credentialSource: "cursor-cli",
		};
	} catch {
		return undefined;
	}
}

function abortError(): Error {
	const error = new Error("Cursor authentication cancelled");
	error.name = "AbortError";
	return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(abortError());
			},
			{ once: true },
		);
	});
}

export async function generateCursorAuthParams(): Promise<{
	verifier: string;
	uuid: string;
	loginUrl: string;
}> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();
	const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
	return { verifier, uuid, loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}` };
}

export async function pollCursorAuth(
	uuid: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delayMs = POLL_BASE_DELAY_MS;
	let consecutiveErrors = 0;
	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await sleep(delayMs, signal);
		try {
			const response = await fetch(
				`${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
				{
					signal,
				},
			);
			if (response.status === 404) {
				consecutiveErrors = 0;
				delayMs = Math.min(Math.ceil(delayMs * 1.2), POLL_MAX_DELAY_MS);
				continue;
			}
			if (!response.ok) throw new Error(`Cursor authentication poll failed with HTTP ${response.status}`);
			const payload = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown };
			if (typeof payload.accessToken !== "string" || typeof payload.refreshToken !== "string") {
				throw new Error("Cursor authentication response is missing tokens");
			}
			return { accessToken: payload.accessToken, refreshToken: payload.refreshToken };
		} catch (error) {
			if (signal?.aborted) throw abortError();
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		}
	}
	throw new Error("Cursor authentication timed out");
}

async function loginCursorBrowser(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
	callbacks.onAuth({ url: loginUrl, instructions: "Complete the Cursor sign-in in your browser." });
	callbacks.onProgress?.("Waiting for Cursor authentication...");
	const tokens = await pollCursorAuth(uuid, verifier, callbacks.signal);
	return {
		access: tokens.accessToken,
		refresh: tokens.refreshToken,
		expires: tokenExpiresAt(tokens.accessToken),
		credentialSource: "prime-oauth",
	};
}

async function exchangeCursorUserApiKey(userApiKey: string): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_API_KEY_EXCHANGE_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${userApiKey}`, "Content-Type": "application/json" },
		body: "{}",
	});
	if (!response.ok) throw new Error(`Cursor User API key exchange failed with HTTP ${response.status}`);
	const payload = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown };
	if (typeof payload.accessToken !== "string")
		throw new Error("Cursor User API key exchange returned no access token");
	return {
		access: payload.accessToken,
		refresh: typeof payload.refreshToken === "string" ? payload.refreshToken : "",
		expires: tokenExpiresAt(payload.accessToken),
		userApiKey,
		credentialSource: "user-api-key",
	};
}

export const cursorAgentOAuthProvider: OAuthProviderInterface = {
	id: "cursor-agent",
	name: "Cursor Subscription",

	async login(callbacks): Promise<OAuthCredentials> {
		const existing = readOfficialCursorCredentials();
		if (existing) {
			const selection = callbacks.onSelect
				? await callbacks.onSelect({
						message: "Use the existing Cursor CLI session or sign in again?",
						options: [
							{ id: "existing", label: "Use existing Cursor CLI session" },
							{ id: "browser", label: "Sign in with Cursor in the browser" },
						],
					})
				: "existing";
			if (selection === undefined) throw abortError();
			if (selection === "existing") {
				callbacks.onProgress?.("Imported the existing Cursor CLI session.");
				return existing;
			}
		}
		return loginCursorBrowser(callbacks);
	},

	async refreshToken(credentials): Promise<OAuthCredentials> {
		if (credentials.credentialSource === "cursor-cli") {
			// Read through the external source again. A running official client may
			// have rotated its access token since Prime imported the previous one.
			const imported = readOfficialCursorCredentials();
			if (imported) return imported;
			throw new Error(
				"The official Cursor session has no new valid access token. Sign in again with the Cursor CLI, then run /login in Prime Agent.",
			);
		}
		if (credentials.credentialSource === "user-api-key") {
			const userApiKey = typeof credentials.userApiKey === "string" ? credentials.userApiKey : undefined;
			if (userApiKey) return exchangeCursorUserApiKey(userApiKey);
			throw new Error("Cursor User API key credentials are incomplete. Run /login and add the User API key again.");
		}
		throw new Error(
			"Cursor access expired and no documented refresh-token exchange is available. Run /login and authenticate Cursor again.",
		);
	},

	getApiKey(credentials): string {
		return credentials.access;
	},
};

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
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

export function readOfficialCursorCredentials(): OAuthCredentials | undefined {
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
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function readBoundedPollJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
	if (!response.body) throw new Error("Cursor authentication response was empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel("Cursor authentication response exceeded limit");
				throw new Error("Cursor authentication response was too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("Cursor authentication response was malformed");
	}
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
): Promise<{ accessToken: string }> {
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
			const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
			if (contentType !== "application/json") {
				throw new Error("Cursor authentication response had an unsupported content type");
			}
			const payload = (await readBoundedPollJson(response)) as {
				accessToken?: unknown;
				refreshToken?: unknown;
			};
			if (typeof payload.accessToken !== "string" || typeof payload.refreshToken !== "string") {
				throw new Error("Cursor authentication response is missing tokens");
			}
			return { accessToken: payload.accessToken };
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
		// Cursor exposes no reviewed refresh exchange for this flow; do not persist an unusable secret.
		refresh: "",
		expires: tokenExpiresAt(tokens.accessToken),
		credentialSource: "prime-oauth",
	};
}

export const cursorAgentOAuthProvider: OAuthProviderInterface = {
	id: "cursor-not-cloud",
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
		throw new Error(
			"Cursor access expired and no documented refresh-token exchange is available. Run /login and authenticate Cursor again.",
		);
	},

	getApiKey(credentials): string {
		return credentials.access;
	},
};

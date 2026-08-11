import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cursorAgentOAuthProvider, getOAuthProvider } from "../src/utils/oauth/index.js";

const tempDirs: string[] = [];

function jwt(exp: number): string {
	return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

function authFile(contents: Record<string, unknown>, mode = 0o600): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-agent-auth-"));
	tempDirs.push(dir);
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify(contents), { mode });
	process.env.CURSOR_AGENT_AUTH_FILE = path;
	return path;
}

afterEach(() => {
	delete process.env.CURSOR_AGENT_AUTH_FILE;
	vi.restoreAllMocks();
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Cursor Agent OAuth", () => {
	it("is registered as a first-class subscription provider", () => {
		expect(getOAuthProvider("cursor-agent")).toBe(cursorAgentOAuthProvider);
		expect(cursorAgentOAuthProvider.name).toBe("Cursor Subscription");
	});

	it("imports an unexpired official access token without copying its refresh token or rewriting the source", async () => {
		const accessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
		const path = authFile({ accessToken, refreshToken: "official-refresh-token" });
		const original = readFileSync(path, "utf8");

		const progress: string[] = [];
		const credentials = await cursorAgentOAuthProvider.login({
			onAuth: () => {
				throw new Error("browser login should not start");
			},
			onPrompt: async () => "",
			onProgress: (message) => progress.push(message),
		});

		expect(credentials.access).toBe(accessToken);
		expect(credentials.refresh).toBe("");
		expect(credentials.credentialSource).toBe("cursor-cli");
		expect(cursorAgentOAuthProvider.getApiKey(credentials)).toBe(accessToken);
		expect(progress).toEqual(["Imported the existing Cursor CLI session."]);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("re-reads an expired official source and adopts only a newly rotated valid access token", async () => {
		const oldAccess = jwt(Math.floor(Date.now() / 1000) - 3600);
		const path = authFile({ accessToken: oldAccess, refreshToken: "do-not-exchange" });
		const stored = {
			access: oldAccess,
			refresh: "legacy-copied-refresh",
			expires: Date.now() - 1,
			credentialSource: "cursor-cli",
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(cursorAgentOAuthProvider.refreshToken(stored)).rejects.toThrow(/sign in again with the Cursor CLI/i);
		expect(fetchSpy).not.toHaveBeenCalled();

		const rotatedAccess = jwt(Math.floor(Date.now() / 1000) + 7200);
		writeFileSync(path, JSON.stringify({ accessToken: rotatedAccess, refreshToken: "rotated-external-refresh" }), {
			mode: 0o600,
		});
		const refreshed = await cursorAgentOAuthProvider.refreshToken(stored);
		expect(refreshed.access).toBe(rotatedAccess);
		expect(refreshed.refresh).toBe("");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects malformed official JWTs instead of treating them as opaque valid sessions", async () => {
		authFile({ accessToken: "not-a-jwt", refreshToken: "do-not-exchange" });
		await expect(
			cursorAgentOAuthProvider.refreshToken({
				access: "not-a-jwt",
				refresh: "do-not-exchange",
				expires: Date.now() - 1,
				credentialSource: "cursor-cli",
			}),
		).rejects.toThrow(/no new valid access token/i);
	});

	it("never posts Prime OAuth or official refresh tokens to the User API-key exchange", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(
			cursorAgentOAuthProvider.refreshToken({
				access: "expired",
				refresh: "unverified-refresh-token",
				expires: 0,
				credentialSource: "prime-oauth",
			}),
		).rejects.toThrow(/no documented refresh-token exchange/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reads a permission-restricted official auth file without changing contents or mode", async () => {
		const accessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
		const path = authFile({ accessToken, refreshToken: "external" }, 0o400);
		chmodSync(path, 0o400);
		const original = readFileSync(path, "utf8");

		const credentials = await cursorAgentOAuthProvider.login({
			onAuth: () => {
				throw new Error("browser login should not start");
			},
			onPrompt: async () => "",
		});
		expect(credentials.access).toBe(accessToken);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(statSync(path).mode & 0o777).toBe(0o400);
	});
});

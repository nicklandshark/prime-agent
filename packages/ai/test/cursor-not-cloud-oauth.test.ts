import { getEventListeners } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollCursorAuth } from "../src/utils/oauth/cursor-not-cloud.js";
import { cursorAgentOAuthProvider, getOAuthProvider } from "../src/utils/oauth/index.js";

const tempDirs: string[] = [];

function jwt(exp: number): string {
	return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

function authFile(contents: Record<string, unknown>, mode = 0o600): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-not-cloud-auth-"));
	tempDirs.push(dir);
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify(contents), { mode });
	process.env.CURSOR_AGENT_AUTH_FILE = path;
	return path;
}

afterEach(() => {
	delete process.env.CURSOR_AGENT_AUTH_FILE;
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Cursor Agent OAuth", () => {
	it("is registered as a first-class subscription provider", () => {
		expect(getOAuthProvider("cursor-not-cloud")).toBe(cursorAgentOAuthProvider);
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

	it("completes browser PKCE polling without persisting the returned unusable refresh secret", async () => {
		authFile({});
		vi.useFakeTimers();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: "discard-me" }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);
		let loginUrl = "";
		const pending = cursorAgentOAuthProvider.login({
			onAuth: ({ url }) => {
				loginUrl = url;
			},
			onPrompt: async () => "",
		});
		await vi.waitFor(() => expect(loginUrl).toContain("https://cursor.com/loginDeepControl?"));
		await vi.advanceTimersByTimeAsync(1_000);
		const credentials = await pending;
		expect(loginUrl).toContain("https://cursor.com/loginDeepControl?");
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("https://api2.cursor.sh/auth/poll?"),
			expect.anything(),
		);
		expect(credentials).toMatchObject({ refresh: "", credentialSource: "prime-oauth" });
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it.each([
		["pending 404", 404, {}],
		["non-2xx", 500, { "content-type": "application/json" }],
		["wrong content type", 200, { "content-type": "text/plain" }],
		["declared oversize", 200, { "content-type": "application/json", "content-length": String(64 * 1024 + 1) }],
	] as const)("cancels a bounded streaming body on early %s polling disposition", async (_name, status, headers) => {
		vi.useFakeTimers();
		let bytesRead = 0;
		let cancelCount = 0;
		let calls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls > 1) {
				return new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					const chunk = new Uint8Array(1024);
					bytesRead += chunk.byteLength;
					controller.enqueue(chunk);
				},
				cancel() {
					cancelCount++;
				},
			});
			return new Response(body, { status, headers });
		});
		const pending = pollCursorAuth("fixture-uuid", "fixture-verifier");
		await vi.advanceTimersByTimeAsync(5_000);
		await expect(pending).resolves.toEqual({ accessToken: "a" });
		expect(cancelCount).toBe(1);
		expect(bytesRead).toBeLessThanOrEqual(1024);
	});

	it("polls through a pending 404 and aborts without leaking token material", async () => {
		vi.useFakeTimers();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ accessToken: "browser-access", refreshToken: "browser-refresh" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const pending = pollCursorAuth("fixture-uuid", "fixture-verifier");
		await vi.advanceTimersByTimeAsync(2_200);
		await expect(pending).resolves.toEqual({ accessToken: "browser-access" });
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		const controller = new AbortController();
		const aborted = pollCursorAuth("fixture-uuid", "fixture-verifier", controller.signal);
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
	});

	it("removes the poll sleep listener after repeated pending responses and success", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const before = getEventListeners(controller.signal, "abort").length;
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(new Response("", { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const pending = pollCursorAuth("fixture-uuid", "fixture-verifier", controller.signal);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(pending).resolves.toEqual({ accessToken: "a" });
		expect(getEventListeners(controller.signal, "abort").length).toBe(before);
	});
});

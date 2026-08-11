import { afterEach, describe, expect, it, vi } from "vitest";
import { extractOpenAICodexIdentity, refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

function makeJwt(payload: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
	return `aaa.${body}.bbb`;
}

function makeAccessToken(accountId: string, email?: string): string {
	return makeJwt({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
		...(email ? { email } : {}),
	});
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	describe("extractOpenAICodexIdentity", () => {
		it("reads the account id from the access token auth claim", () => {
			const identity = extractOpenAICodexIdentity(makeAccessToken("acc_123"));
			expect(identity.accountId).toBe("acc_123");
			expect(identity.email).toBeUndefined();
		});

		it("prefers the email claim of the id token", () => {
			const idToken = makeJwt({ email: "user@example.com" });
			const identity = extractOpenAICodexIdentity(makeAccessToken("acc_123", "stale@example.com"), idToken);
			expect(identity.accountId).toBe("acc_123");
			expect(identity.email).toBe("user@example.com");
		});

		it("falls back to the access token email claim", () => {
			const identity = extractOpenAICodexIdentity(makeAccessToken("acc_123", "user@example.com"));
			expect(identity.email).toBe("user@example.com");
		});

		it("decodes base64url payloads (URL-safe alphabet, stripped padding)", () => {
			// The ">" bytes force index-62/63 sextets, so the base64url form
			// necessarily differs from standard base64 (either -/_ chars or
			// stripped padding): raw atob on it would throw.
			const json = JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "acc_url" },
				email: "url-user@example.com",
				note: ">>>>>>>>",
			});
			const base64url = Buffer.from(json, "utf8").toString("base64url");
			expect(base64url).not.toBe(Buffer.from(json, "utf8").toString("base64"));

			const identity = extractOpenAICodexIdentity(`aaa.${base64url}.bbb`);
			expect(identity.accountId).toBe("acc_url");
			expect(identity.email).toBe("url-user@example.com");
		});

		it("returns empty identity for malformed tokens", () => {
			const identity = extractOpenAICodexIdentity("not-a-jwt");
			expect(identity.accountId).toBeUndefined();
			expect(identity.email).toBeUndefined();
		});
	});

	describe("refreshOpenAICodexToken identity preservation", () => {
		function stubRefreshSuccess(accessToken: string, idToken?: string) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (): Promise<Response> => {
					return new Response(
						JSON.stringify({
							access_token: accessToken,
							refresh_token: "new-refresh-token",
							expires_in: 3600,
							...(idToken ? { id_token: idToken } : {}),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}),
			);
		}

		it("preserves email and accountId from previous credentials when refresh omits them", async () => {
			stubRefreshSuccess(makeAccessToken("acc_123"));

			const refreshed = await refreshOpenAICodexToken("old-refresh-token", {
				access: "old-access",
				refresh: "old-refresh-token",
				expires: Date.now() - 1000,
				accountId: "acc_123",
				email: "user@example.com",
			});

			expect(refreshed.accountId).toBe("acc_123");
			expect(refreshed.email).toBe("user@example.com");
			expect(refreshed.refresh).toBe("new-refresh-token");
		});

		it("uses the email from the refreshed id token when present", async () => {
			stubRefreshSuccess(makeAccessToken("acc_123"), makeJwt({ email: "new@example.com" }));

			const refreshed = await refreshOpenAICodexToken("old-refresh-token", {
				access: "old-access",
				refresh: "old-refresh-token",
				expires: Date.now() - 1000,
				accountId: "acc_123",
				email: "old@example.com",
			});

			expect(refreshed.email).toBe("new@example.com");
		});
	});
});

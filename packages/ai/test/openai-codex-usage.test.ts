import { describe, expect, it, vi } from "vitest";
import {
	fetchOpenAICodexUsage,
	OPENAI_CODEX_USAGE_URL,
	parseOpenAICodexUsageHeaders,
	summarizeOpenAICodexUsage,
} from "../src/utils/openai-codex-usage.js";

describe("summarizeOpenAICodexUsage", () => {
	it("computes remaining from the max of primary/secondary windows", () => {
		const snapshot = summarizeOpenAICodexUsage(
			{
				plan_type: "plus",
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: { used_percent: 40, reset_at: 1_800_000_000 },
					secondary_window: { used_percent: 12, reset_at: 1_800_100_000 },
				},
			},
			1000,
		);

		expect(snapshot).toMatchObject({
			source: "endpoint",
			fetchedAt: 1000,
			planType: "plus",
			allowed: true,
			limitReached: false,
			remainingPercent: 60,
			primaryUsedPercent: 40,
			secondaryUsedPercent: 12,
			// earliest window reset, normalized from seconds to ms
			resetAt: 1_800_000_000_000,
		});
	});

	it("marks limitReached when allowed is false", () => {
		const snapshot = summarizeOpenAICodexUsage({ rate_limit: { allowed: false } }, 1000);
		expect(snapshot.limitReached).toBe(true);
		expect(snapshot.allowed).toBe(false);
	});

	it("marks limitReached when limit_reached is true", () => {
		const snapshot = summarizeOpenAICodexUsage(
			{ rate_limit: { allowed: true, limit_reached: true, primary_window: { used_percent: 20 } } },
			1000,
		);
		expect(snapshot.limitReached).toBe(true);
		expect(snapshot.remainingPercent).toBe(80);
	});

	it("marks limitReached when a window is at 100%", () => {
		const snapshot = summarizeOpenAICodexUsage(
			{ rate_limit: { allowed: true, secondary_window: { used_percent: 100 } } },
			1000,
		);
		expect(snapshot.limitReached).toBe(true);
		expect(snapshot.remainingPercent).toBe(0);
	});

	it("treats malformed payloads as undeterminable errors, never as full quota", () => {
		// None of these carry a recognized availability signal. They must not be
		// read as "0% used": the account manager prefers higher remaining quota,
		// so a fabricated all-clear would make malformed accounts win failover.
		for (const payload of [
			null,
			undefined,
			42,
			"nope",
			[],
			{},
			{ plan_type: "plus" },
			{ rate_limit: "broken" },
			{ rate_limit: null },
			{ rate_limit: {} },
			{ rate_limit: { allowed: true } },
			{ rate_limit: { primary_window: { used_percent: "not-a-number" } } },
		]) {
			const snapshot = summarizeOpenAICodexUsage(payload, 1000);
			expect(snapshot.source).toBe("endpoint");
			expect(snapshot.error).toBeDefined();
			expect(snapshot.limitReached).toBe(false);
			expect(snapshot.remainingPercent).toBeUndefined();
		}
	});

	it("rejects payloads whose account_id has the wrong type", () => {
		const snapshot = summarizeOpenAICodexUsage(
			{ account_id: 42, rate_limit: { limit_reached: false, primary_window: { used_percent: 10 } } },
			1000,
		);
		expect(snapshot.error).toBeDefined();
		expect(snapshot.remainingPercent).toBeUndefined();
	});

	it("honors negative availability signals even without windows", () => {
		const disallowed = summarizeOpenAICodexUsage({ rate_limit: { allowed: false } }, 1000);
		expect(disallowed.error).toBeUndefined();
		expect(disallowed.limitReached).toBe(true);

		const flagged = summarizeOpenAICodexUsage({ rate_limit: { limit_reached: true } }, 1000);
		expect(flagged.error).toBeUndefined();
		expect(flagged.limitReached).toBe(true);
	});

	it("accepts string-encoded numbers and millisecond reset timestamps", () => {
		const snapshot = summarizeOpenAICodexUsage(
			{
				rate_limit: {
					primary_window: { used_percent: "55", reset_at: 1_800_000_000_000 },
				},
			},
			1000,
		);
		expect(snapshot.primaryUsedPercent).toBe(55);
		expect(snapshot.remainingPercent).toBe(45);
		expect(snapshot.resetAt).toBe(1_800_000_000_000);
	});
});

describe("parseOpenAICodexUsageHeaders", () => {
	it("parses codex usage headers case-insensitively", () => {
		const snapshot = parseOpenAICodexUsageHeaders({
			"X-Codex-Primary-Used-Percent": "30",
			"x-codex-secondary-used-percent": "70",
			"x-codex-primary-reset-at": "1800000000",
			"x-codex-secondary-reset-at": "1800100000",
		});

		expect(snapshot).toMatchObject({
			source: "response_headers",
			limitReached: false,
			remainingPercent: 30,
			primaryUsedPercent: 30,
			secondaryUsedPercent: 70,
			resetAt: 1_800_000_000_000,
		});
	});

	it("returns undefined when no usage headers are present", () => {
		expect(parseOpenAICodexUsageHeaders({ "content-type": "text/event-stream" })).toBeUndefined();
		expect(parseOpenAICodexUsageHeaders({})).toBeUndefined();
	});

	it("marks limitReached at 100% on any window", () => {
		const snapshot = parseOpenAICodexUsageHeaders({ "x-codex-primary-used-percent": "100" });
		expect(snapshot?.limitReached).toBe(true);
		expect(snapshot?.remainingPercent).toBe(0);
	});

	it("ignores unparseable values", () => {
		// Fully unparseable: treated as absent.
		expect(
			parseOpenAICodexUsageHeaders({
				"x-codex-primary-used-percent": "not-a-number",
				"x-codex-secondary-reset-at": "soon",
			}),
		).toBeUndefined();

		// Partially valid: known fields parse, garbage fields are dropped.
		const snapshot = parseOpenAICodexUsageHeaders({
			"x-codex-primary-used-percent": "not-a-number",
			"x-codex-secondary-used-percent": "33",
		});
		expect(snapshot).toBeDefined();
		expect(snapshot?.primaryUsedPercent).toBeUndefined();
		expect(snapshot?.secondaryUsedPercent).toBe(33);
		expect(snapshot?.remainingPercent).toBe(67);
		expect(snapshot?.limitReached).toBe(false);
	});
});

describe("fetchOpenAICodexUsage", () => {
	it("sends auth headers and summarizes the payload", async () => {
		const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("Bearer access-token-1");
			expect(headers.get("ChatGPT-Account-Id")).toBe("acc_1");
			expect(headers.get("Accept")).toBe("application/json");
			return new Response(
				JSON.stringify({
					plan_type: "pro",
					rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10 } },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const snapshot = await fetchOpenAICodexUsage({
			accessToken: "access-token-1",
			accountId: "acc_1",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe(OPENAI_CODEX_USAGE_URL);
		expect(snapshot.error).toBeUndefined();
		expect(snapshot.planType).toBe("pro");
		expect(snapshot.remainingPercent).toBe(90);
	});

	it("returns an error snapshot for non-OK responses instead of throwing", async () => {
		const snapshot = await fetchOpenAICodexUsage({
			accessToken: "access-token-1",
			accountId: "acc_1",
			fetchImpl: (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch,
		});
		expect(snapshot.error).toContain("403");
		expect(snapshot.limitReached).toBe(false);
	});

	it("returns an error snapshot on network failure", async () => {
		const snapshot = await fetchOpenAICodexUsage({
			accessToken: "access-token-1",
			accountId: "acc_1",
			fetchImpl: (async () => {
				throw new Error("socket hangup");
			}) as unknown as typeof fetch,
		});
		expect(snapshot.error).toBe("socket hangup");
	});
});

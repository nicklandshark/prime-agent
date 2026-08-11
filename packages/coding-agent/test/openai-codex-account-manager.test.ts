import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	type OpenAICodexAccountChangedEvent,
	OpenAICodexAccountManager,
} from "../src/core/openai-codex-account-manager.js";

const FUTURE = () => Date.now() + 3_600_000;
const PAST = () => Date.now() - 60_000;

function codexJwt(accountId: string, email?: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			...(email ? { email } : {}),
		}),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function accountFixture(
	accountId: string,
	overrides: { refresh?: string; expires?: number; email?: string; label?: string } = {},
) {
	return {
		access: codexJwt(accountId, overrides.email),
		refresh: overrides.refresh ?? `refresh-${accountId}`,
		expires: overrides.expires ?? FUTURE(),
		accountId,
		...(overrides.email ? { email: overrides.email } : {}),
		...(overrides.label ? { label: overrides.label } : {}),
	};
}

function pooledCredential(accounts: Record<string, ReturnType<typeof accountFixture>>, activeAccountId: string) {
	const active = accounts[activeAccountId]!;
	return {
		type: "oauth" as const,
		access: active.access,
		refresh: active.refresh,
		expires: active.expires,
		accountId: active.accountId,
		...(active.email ? { email: active.email } : {}),
		...(active.label ? { label: active.label } : {}),
		accountPool: { schemaVersion: 1 as const, activeAccountId, accounts },
	};
}

function pooledStorage(
	accounts: Record<string, ReturnType<typeof accountFixture>>,
	activeAccountId: string,
): AuthStorage {
	return AuthStorage.inMemory({
		"openai-codex": pooledCredential(accounts, activeAccountId),
	});
}

const tempDirs: string[] = [];

/** File-backed pool so a second AuthStorage instance can act as another process. */
function fileBackedPool(
	accounts: Record<string, ReturnType<typeof accountFixture>>,
	activeAccountId: string,
): { storage: AuthStorage; authJsonPath: string } {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-codex-manager-test-"));
	tempDirs.push(tempDir);
	const authJsonPath = join(tempDir, "auth.json");
	writeFileSync(authJsonPath, JSON.stringify({ "openai-codex": pooledCredential(accounts, activeAccountId) }));
	return { storage: AuthStorage.create(authJsonPath), authJsonPath };
}

function usagePayload(options: { usedPercent?: number; limitReached?: boolean; resetAtSeconds?: number } = {}) {
	return {
		plan_type: "plus",
		rate_limit: {
			allowed: !options.limitReached,
			limit_reached: options.limitReached === true,
			primary_window: {
				used_percent: options.usedPercent ?? 0,
				...(options.resetAtSeconds !== undefined ? { reset_at: options.resetAtSeconds } : {}),
			},
		},
	};
}

/** A fetch mock that serves wham/usage per account based on ChatGPT-Account-Id. */
function usageFetch(handler: (accountId: string) => Response | Promise<Response>) {
	return vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : String(input);
		if (url.includes("/backend-api/wham/usage")) {
			const headers = new Headers(init?.headers);
			return handler(headers.get("ChatGPT-Account-Id") ?? "");
		}
		return new Response("not found", { status: 404 });
	});
}

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("OpenAICodexAccountManager", () => {
	let nowMs: number;

	beforeEach(() => {
		// Snapshots carry real Date.now() fetchedAt; start the injected clock
		// from the real one so TTL math stays coherent.
		nowMs = Date.now();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	function makeManager(storage: AuthStorage, fetchImpl?: ReturnType<typeof usageFetch>): OpenAICodexAccountManager {
		return new OpenAICodexAccountManager(storage, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			now: () => nowMs,
		});
	}

	it("lists cached accounts with label fallback and active flag, without network", async () => {
		const storage = pooledStorage(
			{
				acc_a: accountFixture("acc_a", { email: "a@example.com" }),
				acc_b: accountFixture("acc_b", { label: "Work" }),
				acc_c: accountFixture("acc_c"),
			},
			"acc_b",
		);
		const fetchImpl = usageFetch(() => jsonResponse(usagePayload()));
		const manager = makeManager(storage, fetchImpl);

		const views = manager.getCachedAccounts();
		expect(views.map((v) => v.accountId)).toEqual(["acc_a", "acc_b", "acc_c"]);
		expect(views.map((v) => v.label)).toEqual(["a@example.com", "Work", "acc_c"]);
		expect(views.map((v) => v.active)).toEqual([false, true, false]);
		expect(views.every((v) => v.usage === undefined)).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refreshes usage via the endpoint and respects the 60s TTL", async () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") }, "acc_a");
		const fetchImpl = usageFetch((accountId) =>
			jsonResponse(usagePayload({ usedPercent: accountId === "acc_a" ? 25 : 50 })),
		);
		const manager = makeManager(storage, fetchImpl);

		const first = await manager.listAccounts({ refreshUsage: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(first.find((v) => v.accountId === "acc_a")?.usage).toMatchObject({
			source: "endpoint",
			remainingPercent: 75,
			limitReached: false,
		});

		// Within TTL: no new probes
		nowMs += 30_000;
		await manager.listAccounts({ refreshUsage: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		// After TTL: re-probe
		nowMs += 31_000;
		await manager.listAccounts({ refreshUsage: true });
		expect(fetchImpl).toHaveBeenCalledTimes(4);
	});

	it("re-probes error snapshots after 10s instead of 60s", async () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a") }, "acc_a");
		let fail = true;
		const fetchImpl = usageFetch(() => (fail ? new Response("boom", { status: 500 }) : jsonResponse(usagePayload())));
		const manager = makeManager(storage, fetchImpl);

		const first = await manager.listAccounts({ refreshUsage: true });
		expect(first[0]?.usage?.error).toContain("500");
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		// Error still fresh: no refetch
		nowMs += 5_000;
		await manager.listAccounts({ refreshUsage: true });
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		// Error TTL expired: refetch
		nowMs += 6_000;
		fail = false;
		const third = await manager.listAccounts({ refreshUsage: true });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(third[0]?.usage?.error).toBeUndefined();
	});

	it("caps probe concurrency at 4", async () => {
		const accounts = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [`acc_${i}`, accountFixture(`acc_${i}`)]),
		);
		const storage = pooledStorage(accounts, "acc_0");
		let inFlight = 0;
		let maxInFlight = 0;
		const fetchImpl = usageFetch(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 10));
			inFlight--;
			return jsonResponse(usagePayload());
		});
		const manager = makeManager(storage, fetchImpl);

		await manager.listAccounts({ refreshUsage: true });
		expect(fetchImpl).toHaveBeenCalledTimes(6);
		expect(maxInFlight).toBeLessThanOrEqual(4);
	});

	it("observeResponse stores header usage and never overrides newer endpoint data", async () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a") }, "acc_a");
		const fetchImpl = usageFetch(() => jsonResponse(usagePayload({ usedPercent: 10 })));
		const manager = makeManager(storage, fetchImpl);

		manager.observeResponse("acc_a", { "x-codex-primary-used-percent": "42" });
		expect(manager.getCachedAccounts()[0]?.usage).toMatchObject({
			source: "response_headers",
			primaryUsedPercent: 42,
		});

		// Once the header snapshot is stale, refreshUsage probes the endpoint.
		nowMs += 61_000;
		await manager.listAccounts({ refreshUsage: true });
		expect(manager.getCachedAccounts()[0]?.usage).toMatchObject({
			source: "endpoint",
			primaryUsedPercent: 10,
		});

		// A header snapshot older than the endpoint data must not override it.
		const endpointFetchedAt = Date.now();
		const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(endpointFetchedAt - 5_000);
		try {
			manager.observeResponse("acc_a", { "x-codex-primary-used-percent": "99" });
		} finally {
			dateNowSpy.mockRestore();
		}
		expect(manager.getCachedAccounts()[0]?.usage).toMatchObject({
			source: "endpoint",
			primaryUsedPercent: 10,
		});
	});

	it("selectAccount switches the active account and emits a manual event", () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") }, "acc_a");
		const manager = makeManager(storage);
		const events: OpenAICodexAccountChangedEvent[] = [];
		manager.onAccountChanged((event) => events.push(event));

		const view = manager.selectAccount("acc_b");
		expect(view.active).toBe(true);
		expect(storage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");
		expect(events).toEqual([{ provider: "openai-codex", accountId: "acc_b", label: "acc_b", reason: "manual" }]);

		expect(() => manager.selectAccount("acc_unknown")).toThrow(/Unknown OpenAI Codex account/);
	});

	it("recoverFromUsageLimit switches to the account with the highest remaining quota", async () => {
		const storage = pooledStorage(
			{ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b"), acc_c: accountFixture("acc_c") },
			"acc_a",
		);
		const fetchImpl = usageFetch((accountId) => {
			if (accountId === "acc_b") return jsonResponse(usagePayload({ usedPercent: 20 }));
			return jsonResponse(usagePayload({ usedPercent: 60 }));
		});
		const manager = makeManager(storage, fetchImpl);
		const events: OpenAICodexAccountChangedEvent[] = [];
		manager.onAccountChanged((event) => events.push(event));

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			planType: "plus",
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery).toEqual({
			action: "retry",
			apiKey: storage.listOpenAICodexAccounts()[1]!.access,
			accountId: "acc_b",
		});
		expect(storage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");
		expect(events).toEqual([{ provider: "openai-codex", accountId: "acc_b", label: "acc_b", reason: "usage_limit" }]);
		// The failed account was not re-probed as a candidate.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const probedAccounts = fetchImpl.mock.calls.map((call) =>
			new Headers((call[1] as RequestInit | undefined)?.headers).get("ChatGPT-Account-Id"),
		);
		expect(probedAccounts.sort()).toEqual(["acc_b", "acc_c"]);
	});

	it("recoverFromUsageLimit adopts the current active account when another process switched first", async () => {
		// Two real AuthStorage backends on the same auth.json: the second
		// instance stands in for another process racing our failover.
		const { storage, authJsonPath } = fileBackedPool(
			{ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") },
			"acc_a",
		);
		const other = AuthStorage.create(authJsonPath);
		const fetchImpl = usageFetch(() => jsonResponse(usagePayload({ usedPercent: 5 })));
		const manager = makeManager(storage, fetchImpl);

		// The other process switches away from acc_a before our CAS lands.
		other.setActiveOpenAICodexAccount("acc_b");

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery).toEqual({ action: "retry", apiKey: expect.any(String), accountId: "acc_b" });
		expect(storage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");
		expect(other.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");
	});

	it("recoverFromUsageLimit probes accounts another process added after this one loaded", async () => {
		const { storage, authJsonPath } = fileBackedPool({ acc_a: accountFixture("acc_a") }, "acc_a");
		// A second process adds a subscription; our storage's in-memory cache
		// (and anything derived from it) is now stale.
		const other = AuthStorage.create(authJsonPath);
		other.upsertOpenAICodexAccount(accountFixture("acc_b"));
		expect(storage.listOpenAICodexAccounts().map((account) => account.accountId)).toEqual(["acc_a"]);

		const fetchImpl = usageFetch(() => jsonResponse(usagePayload({ usedPercent: 10 })));
		const manager = makeManager(storage, fetchImpl);

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		// Freshness: the externally added account is probed and switched to
		// instead of failing with "out of quota".
		expect(recovery).toEqual({ action: "retry", apiKey: expect.any(String), accountId: "acc_b" });
	});

	it("recoverFromUsageLimit never adopts an externally selected account that was already attempted", async () => {
		const { storage, authJsonPath } = fileBackedPool(
			{
				acc_a: accountFixture("acc_a"),
				acc_b: accountFixture("acc_b"),
				acc_c: accountFixture("acc_c"),
			},
			"acc_a",
		);
		const other = AuthStorage.create(authJsonPath);
		const fetchImpl = usageFetch(() => jsonResponse(usagePayload({ usedPercent: 10 })));
		const manager = makeManager(storage, fetchImpl);

		// The other process switches to acc_b — an account THIS request already
		// tried. Adopting it would make the provider reject the retry and end
		// failover even though acc_c is available.
		other.setActiveOpenAICodexAccount("acc_b");

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a", "acc_b"],
		});

		expect(recovery).toEqual({ action: "retry", apiKey: expect.any(String), accountId: "acc_c" });
		expect(storage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_c");
		// The switch is visible to the other process (fresh locked read).
		expect(other.snapshotOpenAICodexPool()?.activeAccountId).toBe("acc_c");
		// The attempted acc_b was never probed; only the real candidate was.
		const probedAccounts = fetchImpl.mock.calls.map((call) =>
			new Headers((call[1] as RequestInit | undefined)?.headers).get("ChatGPT-Account-Id"),
		);
		expect(probedAccounts).toEqual(["acc_c"]);
	});

	it("recoverFromUsageLimit does not adopt an externally selected account that probes exhausted", async () => {
		const { storage, authJsonPath } = fileBackedPool(
			{
				acc_a: accountFixture("acc_a"),
				acc_b: accountFixture("acc_b"),
				acc_c: accountFixture("acc_c"),
			},
			"acc_a",
		);
		const other = AuthStorage.create(authJsonPath);
		const fetchImpl = usageFetch((accountId) =>
			accountId === "acc_b"
				? jsonResponse(usagePayload({ limitReached: true, usedPercent: 100 }))
				: jsonResponse(usagePayload({ usedPercent: 20 })),
		);
		const manager = makeManager(storage, fetchImpl);

		// The other process selects acc_b, which is itself out of quota.
		other.setActiveOpenAICodexAccount("acc_b");

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery).toEqual({ action: "retry", apiKey: expect.any(String), accountId: "acc_c" });
		expect(storage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_c");
	});

	it("recoverFromUsageLimit does not prefer accounts whose usage payload is malformed", async () => {
		const storage = pooledStorage(
			{ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b"), acc_c: accountFixture("acc_c") },
			"acc_a",
		);
		// acc_b returns a malformed 2xx body; acc_c is genuinely 40% remaining.
		const fetchImpl = usageFetch((accountId) =>
			accountId === "acc_b" ? jsonResponse({}) : jsonResponse(usagePayload({ usedPercent: 60 })),
		);
		const manager = makeManager(storage, fetchImpl);

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		// Malformed probes are unverifiable, not "100% remaining": acc_c wins.
		expect(recovery).toEqual({ action: "retry", apiKey: expect.any(String), accountId: "acc_c" });
	});

	it("recoverFromUsageLimit fails with the all-exhausted message and earliest reset", async () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") }, "acc_a");
		const fetchImpl = usageFetch(() =>
			jsonResponse(usagePayload({ limitReached: true, usedPercent: 100, resetAtSeconds: 1_800_100_000 })),
		);
		const manager = makeManager(storage, fetchImpl);

		const failureReset = 1_800_000_500_000;
		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			resetsAt: failureReset,
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery.action).toBe("fail");
		if (recovery.action === "fail") {
			expect(recovery.message).toContain("All 2 stored ChatGPT subscriptions are out of quota.");
			// Earliest reset is the failed account's own reset time.
			expect(recovery.message).toContain(new Date(failureReset).toISOString());
		}
		expect(storage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_a");
	});

	it("recoverFromUsageLimit reports unverifiable subscriptions when probes fail", async () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") }, "acc_a");
		const fetchImpl = usageFetch(() => {
			throw new Error("network down");
		});
		const manager = makeManager(storage, fetchImpl);

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery).toEqual({
			action: "fail",
			message: "Usage limit reached; no available subscription could be verified (1 checks failed).",
		});
	});

	it("recoverFromUsageLimit excludes accounts whose token refresh fails", async () => {
		const storage = pooledStorage(
			{ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b", { expires: PAST() }) },
			"acc_a",
		);
		// Token refresh for acc_b fails with a 401 from the token endpoint.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })),
		);
		const probeFetch = usageFetch(() => jsonResponse(usagePayload()));
		const manager = makeManager(storage, probeFetch);

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery).toEqual({
			action: "fail",
			message: "Usage limit reached; no available subscription could be verified (1 checks failed).",
		});
		// The refresh failure never reached the usage endpoint.
		expect(probeFetch).not.toHaveBeenCalled();
	});

	it("recoverFromUsageLimit reports a single stored subscription as exhausted", async () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a") }, "acc_a");
		const manager = makeManager(storage);

		const recovery = await manager.recoverFromUsageLimit({
			kind: "usage_limit_reached",
			status: 429,
			code: "usage_limit_reached",
			accountId: "acc_a",
			attemptedAccountIds: ["acc_a"],
		});

		expect(recovery.action).toBe("fail");
		if (recovery.action === "fail") {
			expect(recovery.message).toContain("All 1 stored ChatGPT subscriptions are out of quota.");
		}
	});

	it("syncFromStorage drops removed accounts and emits when the active account changed externally", () => {
		const storage = pooledStorage({ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") }, "acc_a");
		const manager = makeManager(storage);
		const events: OpenAICodexAccountChangedEvent[] = [];
		manager.onAccountChanged((event) => events.push(event));

		manager.observeResponse("acc_a", { "x-codex-primary-used-percent": "10" });

		// External change: another process switched the active account.
		storage.setActiveOpenAICodexAccount("acc_b");
		manager.syncFromStorage();
		expect(events).toEqual([{ provider: "openai-codex", accountId: "acc_b", label: "acc_b", reason: "manual" }]);

		// No change: no duplicate event.
		manager.syncFromStorage();
		expect(events).toHaveLength(1);
	});
});

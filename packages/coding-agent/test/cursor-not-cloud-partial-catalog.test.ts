import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getCursorNotCloudAccountManager } from "../src/core/cursor-not-cloud-account-manager.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const { getCatalog } = vi.hoisted(() => ({ getCatalog: vi.fn() }));
vi.mock("@earendil-works/pi-ai/cursor-not-cloud/discovery", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-ai/cursor-not-cloud/discovery")>()),
	getCursorAgentModelCatalog: getCatalog,
}));

function registry(): ModelRegistry {
	const auth = AuthStorage.inMemory();
	auth.setRuntimeApiKey("cursor-not-cloud", "fixture-subscription-access");
	return ModelRegistry.inMemory(auth);
}

function catalog(...modelIds: string[]) {
	return { modelIds: new Set(modelIds), stale: false, refreshedAt: 1 };
}

describe("cursor-not-cloud partial catalog RLM resolution", () => {
	beforeEach(() => {
		getCatalog.mockReset();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
	});
	afterEach(() => {
		getCursorNotCloudAccountManager().clear();
		vi.restoreAllMocks();
	});
	test("carries the exact auth source token in resolved request auth", async () => {
		const value = registry();
		const model = value.getAvailable().find((candidate) => candidate.provider === "cursor-not-cloud");
		if (!model) throw new Error("missing cursor model");
		const auth = await value.getApiKeyAndHeaders(model);
		expect(auth).toMatchObject({
			ok: true,
			apiKey: "fixture-subscription-access",
			sourceToken: { provider: "cursor-not-cloud", source: "runtime" },
		});
	});

	test("keeps the logical model when any normal route is entitled without mutating route metadata", async () => {
		getCatalog.mockResolvedValueOnce(catalog("cursor-grok-4.6-low"));
		const executable = await registry().getExecutableModels();
		const models = executable.filter((candidate) => candidate.provider === "cursor-not-cloud");
		expect(models.map((model) => model.id)).toEqual(["cursor-grok-4.6-high"]);
		const model = models[0];
		expect(model?.thinkingLevelMap).toMatchObject({
			low: "cursor-grok-4.6-low",
			medium: "cursor-grok-4.6-medium",
			high: "cursor-grok-4.6-high",
			xhigh: "cursor-grok-4.6-xhigh",
		});
	});

	test("filters each logical Grok family independently for partial entitlements", async () => {
		getCatalog.mockResolvedValueOnce(catalog("cursor-grok-4.5-high-fast", "cursor-grok-4.6-medium"));
		const executable = await registry().getExecutableModels();
		const models = executable.filter((candidate) => candidate.provider === "cursor-not-cloud");
		expect(models.map((model) => model.id)).toEqual(["cursor-grok-4.6-high"]);
		expect(models[0]?.thinkingLevelMap).toMatchObject({
			low: "cursor-grok-4.6-low",
			medium: "cursor-grok-4.6-medium",
			high: "cursor-grok-4.6-high",
			xhigh: "cursor-grok-4.6-xhigh",
		});
	});

	test.each([
		["fast-only", ["cursor-grok-4.6-high-fast"]],
		["successful-empty", []],
	] as const)("hides the logical RLM model for %s discovery", async (_name, ids) => {
		getCatalog.mockResolvedValueOnce(catalog(...ids));
		const executable = await registry().getExecutableModels();
		expect(executable.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(false);
	});

	test("retries a cold discovery 401 once only after official credential rotation", async () => {
		const value = registry();
		const model = value.getAvailable().find((candidate) => candidate.provider === "cursor-not-cloud");
		if (!model) throw new Error("missing cursor model");
		const requestAuth = await value.getApiKeyAndHeaders(model);
		if (!requestAuth.ok || !requestAuth.sourceToken) throw new Error("missing request source");
		const recover = vi.spyOn(value, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(true);
		getCatalog
			.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401, name: "CursorDiscoveryError" }))
			.mockResolvedValueOnce(catalog("cursor-grok-4.6-high"));
		// The production branch intentionally uses instanceof; construct the exact exported error.
		const discovery = await import("@earendil-works/pi-ai/cursor-not-cloud/discovery");
		getCatalog.mockReset();
		getCatalog.mockRejectedValueOnce(new discovery.CursorDiscoveryError("unauthorized", "http", 401));
		getCatalog.mockResolvedValueOnce(catalog("cursor-grok-4.6-high"));
		const models = await value.getExecutableModels();
		expect(recover).toHaveBeenCalledTimes(1);
		expect(recover).toHaveBeenCalledWith(requestAuth.sourceToken);
		expect(getCatalog).toHaveBeenCalledTimes(2);
		expect(models.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(true);
	});

	test("does not retry an unchanged official credential and marks its exact source stale", async () => {
		const value = registry();
		const discovery = await import("@earendil-works/pi-ai/cursor-not-cloud/discovery");
		getCatalog.mockRejectedValueOnce(new discovery.CursorDiscoveryError("forbidden", "http", 403));
		const model = value.getAvailable().find((candidate) => candidate.provider === "cursor-not-cloud");
		if (!model) throw new Error("missing cursor model");
		const requestAuth = await value.getApiKeyAndHeaders(model);
		if (!requestAuth.ok || !requestAuth.sourceToken) throw new Error("missing request source");
		const failed = requestAuth.sourceToken;
		const recover = vi.spyOn(value, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(false);
		const stale = vi.spyOn(value, "markProviderAuthSourceStale").mockReturnValueOnce(true);
		const models = await value.getExecutableModels();
		expect(recover).toHaveBeenCalledTimes(1);
		expect(stale).toHaveBeenCalledWith(failed);
		expect(getCatalog).toHaveBeenCalledTimes(1);
		expect(models.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(false);
	});

	test("lets a late old discovery failure observe concurrent rotation and retry without staling new auth", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("cursor-not-cloud", "old-runtime-access");
		const value = ModelRegistry.inMemory(authStorage);
		const model = value.getAvailable().find((candidate) => candidate.provider === "cursor-not-cloud");
		if (!model) throw new Error("missing cursor model");
		const oldAuth = await value.getApiKeyAndHeaders(model);
		if (!oldAuth.ok || !oldAuth.sourceToken) throw new Error("missing old source");
		let rejectOld!: (error: Error) => void;
		let oldCalls = 0;
		getCatalog.mockImplementation((apiKey: string) => {
			if (apiKey === "old-runtime-access") {
				oldCalls++;
				return new Promise((_resolve, reject) => {
					rejectOld = reject;
				});
			}
			return Promise.resolve(catalog("cursor-grok-4.6-high"));
		});
		const stale = vi.spyOn(value, "markProviderAuthSourceStale");
		const first = value.getExecutableModels();
		await vi.waitFor(() => expect(oldCalls).toBe(1));
		authStorage.setRuntimeApiKey("cursor-not-cloud", "new-runtime-access");
		const concurrent = await value.getExecutableModels();
		expect(concurrent.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(true);
		rejectOld(
			new (await import("@earendil-works/pi-ai/cursor-not-cloud/discovery")).CursorDiscoveryError(
				"late",
				"http",
				401,
			),
		);
		const retried = await first;
		expect(retried.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(true);
		expect(stale).not.toHaveBeenCalled();
		const next = await value.getApiKeyAndHeaders(model);
		if (!next.ok) throw new Error("missing new source");
		expect(next.sourceToken?.valueFingerprint).not.toBe(oldAuth.sourceToken.valueFingerprint);
		expect(getCatalog.mock.calls.map(([apiKey]) => apiKey)).toEqual([
			"old-runtime-access",
			"new-runtime-access",
			"new-runtime-access",
		]);
	});

	test("concurrent unchanged discovery failures stale only their shared bound old source", async () => {
		const value = registry();
		const model = value.getAvailable().find((candidate) => candidate.provider === "cursor-not-cloud");
		if (!model) throw new Error("missing cursor model");
		const requestAuth = await value.getApiKeyAndHeaders(model);
		if (!requestAuth.ok || !requestAuth.sourceToken) throw new Error("missing request source");
		const rejects: Array<(error: Error) => void> = [];
		getCatalog.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejects.push(reject);
				}),
		);
		const stale = vi.spyOn(value, "markProviderAuthSourceStale");
		const first = value.getExecutableModels();
		await vi.waitFor(() => expect(rejects).toHaveLength(1));
		const second = value.getExecutableModels();
		await vi.waitFor(() => expect(rejects).toHaveLength(2));
		const discovery = await import("@earendil-works/pi-ai/cursor-not-cloud/discovery");
		for (const reject of rejects) reject(new discovery.CursorDiscoveryError("unchanged", "http", 403));
		const [firstModels, secondModels] = await Promise.all([first, second]);
		expect(firstModels.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(false);
		expect(secondModels.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(false);
		expect(stale).toHaveBeenCalledTimes(2);
		for (const [source] of stale.mock.calls) expect(source).toEqual(requestAuth.sourceToken);
	});
});

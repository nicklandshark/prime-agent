import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
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
	beforeEach(() => getCatalog.mockReset());
	test("keeps the logical model when any normal route is entitled without mutating route metadata", async () => {
		getCatalog.mockResolvedValueOnce(catalog("cursor-grok-4.5-low"));
		const executable = await registry().getExecutableModels();
		const model = executable.find((candidate) => candidate.provider === "cursor-not-cloud");
		expect(model?.id).toBe("cursor-grok-4.5-high");
		expect(model?.thinkingLevelMap).toMatchObject({
			low: "cursor-grok-4.5-low",
			medium: "cursor-grok-4.5-medium",
			high: "cursor-grok-4.5-high",
		});
	});

	test.each([
		["fast-only", ["cursor-grok-4.5-high-fast"]],
		["successful-empty", []],
	] as const)("hides the logical RLM model for %s discovery", async (_name, ids) => {
		getCatalog.mockResolvedValueOnce(catalog(...ids));
		const executable = await registry().getExecutableModels();
		expect(executable.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(false);
	});

	test("retries a cold discovery 401 once only after official credential rotation", async () => {
		const value = registry();
		const recover = vi.spyOn(value, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(true);
		getCatalog
			.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401, name: "CursorDiscoveryError" }))
			.mockResolvedValueOnce(catalog("cursor-grok-4.5-high"));
		// The production branch intentionally uses instanceof; construct the exact exported error.
		const discovery = await import("@earendil-works/pi-ai/cursor-not-cloud/discovery");
		getCatalog.mockReset();
		getCatalog.mockRejectedValueOnce(new discovery.CursorDiscoveryError("unauthorized", "http", 401));
		getCatalog.mockResolvedValueOnce(catalog("cursor-grok-4.5-high"));
		const models = await value.getExecutableModels();
		expect(recover).toHaveBeenCalledTimes(1);
		expect(getCatalog).toHaveBeenCalledTimes(2);
		expect(models.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(true);
	});

	test("does not retry an unchanged official credential and marks its exact source stale", async () => {
		const value = registry();
		const discovery = await import("@earendil-works/pi-ai/cursor-not-cloud/discovery");
		getCatalog.mockRejectedValueOnce(new discovery.CursorDiscoveryError("forbidden", "http", 403));
		const failed = {
			provider: "cursor-not-cloud",
			source: "runtime",
			identityFingerprint: "i",
			valueFingerprint: "v",
		} as const;
		vi.spyOn(value, "getCurrentProviderAuthSourceToken").mockReturnValue(failed);
		const recover = vi.spyOn(value, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(false);
		const stale = vi.spyOn(value, "markProviderAuthSourceStale").mockReturnValueOnce(true);
		const models = await value.getExecutableModels();
		expect(recover).toHaveBeenCalledTimes(1);
		expect(stale).toHaveBeenCalledWith(failed);
		expect(getCatalog).toHaveBeenCalledTimes(1);
		expect(models.some((candidate) => candidate.provider === "cursor-not-cloud")).toBe(false);
	});
});

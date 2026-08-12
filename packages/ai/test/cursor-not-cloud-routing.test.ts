import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, supportsFastMode } from "../src/index.js";
import {
	CURSOR_GROK_45_ROUTE_IDS,
	calculateCursorAgentUsageCost,
	hasCursorAgentLogicalModelRoutes,
	resolveCursorAgentModelId,
	resolveCursorClientVersion,
} from "../src/providers/cursor-not-cloud/index.js";
import type { ModelThinkingLevel, Usage } from "../src/types.js";

const grok = getModel("cursor-not-cloud", "cursor-grok-4.5-high");
if (!grok) throw new Error("missing Cursor Grok fixture model");

const matrix: Array<[ModelThinkingLevel, "low" | "medium" | "high", string, string]> = [
	["off", "low", "cursor-grok-4.5-low", "cursor-grok-4.5-low-fast"],
	["minimal", "low", "cursor-grok-4.5-low", "cursor-grok-4.5-low-fast"],
	["low", "low", "cursor-grok-4.5-low", "cursor-grok-4.5-low-fast"],
	["medium", "medium", "cursor-grok-4.5-medium", "cursor-grok-4.5-medium-fast"],
	["high", "high", "cursor-grok-4.5-high", "cursor-grok-4.5-high-fast"],
	["xhigh", "high", "cursor-grok-4.5-high", "cursor-grok-4.5-high-fast"],
	["max", "high", "cursor-grok-4.5-high", "cursor-grok-4.5-high-fast"],
];

describe("cursor-not-cloud model routing", () => {
	it("ships exactly one logical Grok model with the reviewed metadata", () => {
		expect(getSupportedThinkingLevels(grok)).toEqual(["low", "medium", "high"]);
		expect(grok).toMatchObject({
			name: "Cursor Grok 4.5",
			provider: "cursor-not-cloud",
			api: "cursor-not-cloud",
			baseUrl: "https://api2.cursor.sh",
			contextWindow: 256000,
			maxTokens: 64000,
			cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it.each(matrix)(
		"clamps requested %s to %s and routes exact normal/fast siblings",
		(requested, resolved, normal, fast) => {
			expect(clampThinkingLevel(grok, requested)).toBe(resolved);
			expect(resolveCursorAgentModelId(grok, { reasoning: requested, serviceTier: "default" })).toBe(normal);
			expect(resolveCursorAgentModelId(grok, { reasoning: requested, serviceTier: "priority" })).toBe(fast);
		},
	);

	it("exposes the logical model with any normal route but not fast-only or empty catalogs", () => {
		expect(hasCursorAgentLogicalModelRoutes(grok.id, new Set(["cursor-grok-4.5-low"]))).toBe(true);
		expect(hasCursorAgentLogicalModelRoutes(grok.id, new Set(["cursor-grok-4.5-high-fast"]))).toBe(false);
		expect(hasCursorAgentLogicalModelRoutes(grok.id, new Set())).toBe(false);
		expect(new Set(CURSOR_GROK_45_ROUTE_IDS).size).toBe(6);
	});

	it("enables fast only for the logical subscription Grok model", () => {
		expect(supportsFastMode(grok)).toBe(true);
		const cloud = getModel("cursor", "cloud-agent");
		expect(cloud && supportsFastMode(cloud)).toBe(false);
	});

	it("bills terminal input/output at documented normal and fast estimates with cache unpriced", () => {
		const usage: Usage = {
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 1_000_000,
			cacheWrite: 0,
			totalTokens: 3_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCursorAgentUsageCost(grok, "cursor-grok-4.5-high", usage);
		expect(usage.cost).toEqual({ input: 2, output: 6, cacheRead: 0, cacheWrite: 0, total: 8 });
		calculateCursorAgentUsageCost(grok, "cursor-grok-4.5-high-fast", usage);
		expect(usage.cost).toEqual({ input: 4, output: 18, cacheRead: 0, cacheWrite: 0, total: 22 });
	});

	it("uses explicit/env client version before the schema-matched pin and rejects header injection", () => {
		expect(resolveCursorClientVersion("cli-custom-1")).toBe("cli-custom-1");
		expect(resolveCursorClientVersion()).toMatch(/^cli-2026\.08\.11-e8db854$/);
		expect(() => resolveCursorClientVersion("cli-ok\r\nx-evil: 1")).toThrow(/header-safe/);
	});
});

import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels, supportsFastMode } from "../src/index.js";
import {
	CURSOR_GROK_45_ROUTE_IDS,
	CURSOR_KIMI_K3_ROUTE_IDS,
	calculateCursorAgentUsageCost,
	hasCursorAgentLogicalModelRoutes,
	resolveCursorAgentModelId,
} from "../src/providers/cursor-agent/index.js";

describe("Cursor Agent model routing", () => {
	const grok = getModel("cursor-agent", "cursor-grok-4.5-high");
	const kimi = getModel("cursor-agent", "kimi-k3-max");

	it("exposes only truthful Grok 4.5 reasoning levels", () => {
		expect(getSupportedThinkingLevels(grok)).toEqual(["medium", "high", "xhigh"]);
		expect(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) =>
				clampThinkingLevel(grok, level as Parameters<typeof clampThinkingLevel>[1]),
			),
		).toEqual(["medium", "medium", "medium", "medium", "high", "xhigh", "xhigh"]);
	});

	it.each([
		["medium", "cursor-grok-4.5-low", "cursor-grok-4.5-low-fast"],
		["high", "cursor-grok-4.5-medium", "cursor-grok-4.5-medium-fast"],
		["xhigh", "cursor-grok-4.5-high", "cursor-grok-4.5-high-fast"],
	] as const)("routes Grok %s across normal and fast siblings", (reasoning, normalId, fastId) => {
		expect(resolveCursorAgentModelId(grok, { reasoning, serviceTier: "default" })).toBe(normalId);
		expect(resolveCursorAgentModelId(grok, { reasoning, serviceTier: "priority" })).toBe(fastId);
	});

	it("exposes Kimi K3 low/high/max and never invents a fast route", () => {
		expect(getSupportedThinkingLevels(kimi)).toEqual(["low", "high", "max"]);
		expect(clampThinkingLevel(kimi, "off")).toBe("low");
		expect(clampThinkingLevel(kimi, "medium")).toBe("high");
		expect(clampThinkingLevel(kimi, "xhigh")).toBe("max");
		expect(resolveCursorAgentModelId(kimi, { reasoning: "low", serviceTier: "priority" })).toBe("kimi-k3-low");
		expect(resolveCursorAgentModelId(kimi, { reasoning: "high", serviceTier: "priority" })).toBe("kimi-k3-high");
		expect(resolveCursorAgentModelId(kimi, { reasoning: "max", serviceTier: "priority" })).toBe("kimi-k3-max");
	});

	it("fail-closes logical models when a live route disappears", () => {
		const ids = new Set<string>([...CURSOR_GROK_45_ROUTE_IDS, ...CURSOR_KIMI_K3_ROUTE_IDS]);
		expect(hasCursorAgentLogicalModelRoutes(grok.id, ids)).toBe(true);
		expect(hasCursorAgentLogicalModelRoutes(kimi.id, ids)).toBe(true);
		ids.delete("cursor-grok-4.5-high-fast");
		expect(hasCursorAgentLogicalModelRoutes(grok.id, ids)).toBe(false);
		expect(hasCursorAgentLogicalModelRoutes(kimi.id, ids)).toBe(true);
	});

	it("enables fast only for Cursor Grok", () => {
		expect(supportsFastMode(grok)).toBe(true);
		expect(supportsFastMode(kimi)).toBe(false);
	});

	it("bills fast Grok routes at the published fast rates", () => {
		const newUsage = (input: number, output: number) => ({
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		// Fast routes bill $4/M input, $18/M output, not the standard $2/$6 metadata.
		for (const fastId of ["cursor-grok-4.5-low-fast", "cursor-grok-4.5-medium-fast", "cursor-grok-4.5-high-fast"]) {
			const fastUsage = newUsage(1_000_000, 1_000_000);
			calculateCursorAgentUsageCost(grok, fastId, fastUsage);
			expect(fastUsage.cost.input).toBeCloseTo(4);
			expect(fastUsage.cost.output).toBeCloseTo(18);
			expect(fastUsage.cost.total).toBeCloseTo(22);
		}

		const standardUsage = newUsage(1_000_000, 1_000_000);
		calculateCursorAgentUsageCost(grok, "cursor-grok-4.5-high", standardUsage);
		expect(standardUsage.cost.input).toBeCloseTo(2);
		expect(standardUsage.cost.output).toBeCloseTo(6);

		// Kimi has no fast route; its standard rates apply to every route id.
		const kimiUsage = newUsage(1_000_000, 1_000_000);
		calculateCursorAgentUsageCost(kimi, "kimi-k3-low", kimiUsage);
		expect(kimiUsage.cost.input).toBeCloseTo(3);
		expect(kimiUsage.cost.output).toBeCloseTo(15);
	});
});

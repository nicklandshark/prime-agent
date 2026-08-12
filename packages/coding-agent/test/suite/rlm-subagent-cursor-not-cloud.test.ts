import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai";
import { resolveCursorAgentModelId } from "@earendil-works/pi-ai/cursor-not-cloud";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.js";

const cursorOptions = {
	api: "cursor-not-cloud",
	provider: "cursor-not-cloud",
	models: [{ id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5", reasoning: true }],
};
const realModel = getModel("cursor-not-cloud", "cursor-grok-4.5-high");
if (!realModel) throw new Error("Cursor Grok model missing");

describe("RLM cursor-not-cloud reasoning and fast inheritance", () => {
	it.each([
		["omitted inherits priority", "priority", undefined, true, "cursor-grok-4.5-high-fast"],
		["true enables priority", "default", true, true, "cursor-grok-4.5-high-fast"],
		["false forces default", "priority", false, false, "cursor-grok-4.5-high"],
	] as const)("%s", async (_name, parentTier, fast, expectedFast, expectedRoute) => {
		const harness = await createHarness(cursorOptions);
		try {
			harness.session.setThinkingLevel("high");
			harness.session.setServiceTier(parentTier);
			harness.setResponses([
				(_context, options) => {
					expect(resolveCursorAgentModelId(realModel, options)).toBe(expectedRoute);
					return fauxAssistantMessage("cursor child answer");
				},
			]);
			const kwargs = fast === undefined ? {} : { fast };
			const result = await harness.session.runRlmChild("run with inherited Cursor subscription settings", kwargs);
			expect(result).toMatchObject({
				model: "cursor-not-cloud/cursor-grok-4.5-high",
				thinking: "high",
				fast: expectedFast,
			});
			expect(harness.session.serviceTier).toBe(parentTier);
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.serviceTier).toBe(
					expectedFast ? "priority" : "default",
				);
			});
		} finally {
			harness.cleanup();
		}
	});

	it("reports resolved thinking, rejects null fast, and rejects cloud targeting kwargs", async () => {
		const harness = await createHarness(cursorOptions);
		try {
			harness.setResponses([fauxAssistantMessage("clamped")]);
			const result = await harness.session.runRlmChild("clamp unsupported xhigh", { thinking: "xhigh" });
			expect(result.thinking).toBe("high");
			await expect(harness.session.runRlmChild("bad null", { fast: null })).rejects.toThrow(
				"rlm.run fast must be a boolean",
			);
			await expect(
				harness.session.runRlmChild("bad cloud kwargs", { environment: "some-cloud-environment" }),
			).rejects.toThrow(/require a cursor model.*cursor\/cloud-agent/i);
		} finally {
			harness.cleanup();
		}
	});
});

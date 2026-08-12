import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai";
import { resolveCursorAgentModelId } from "@earendil-works/pi-ai/cursor-not-cloud";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.js";

const cursorOptions = {
	api: "cursor-not-cloud",
	provider: "cursor-not-cloud",
	models: [
		{
			id: "cursor-grok-4.6-high",
			name: "Cursor Grok 4.6",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "cursor-grok-4.6-low",
				medium: "cursor-grok-4.6-medium",
				high: "cursor-grok-4.6-high",
				xhigh: "cursor-grok-4.6-xhigh",
				max: null,
			},
		},
	],
};
const realModel = getModel("cursor-not-cloud", "cursor-grok-4.6-high");
if (!realModel) throw new Error("Cursor Grok model missing");

describe("RLM cursor-not-cloud reasoning and fast inheritance", () => {
	it.each([
		["omitted inherits priority", "priority", undefined, true, "cursor-grok-4.6-xhigh-fast"],
		["true enables priority", "default", true, true, "cursor-grok-4.6-xhigh-fast"],
		["false forces default", "priority", false, false, "cursor-grok-4.6-xhigh"],
	] as const)("Grok 4.6 %s", async (_name, parentTier, fast, expectedFast, expectedRoute) => {
		const harness = await createHarness(cursorOptions);
		try {
			await harness.session.setModel(realModel);
			harness.session.setServiceTier(parentTier);
			harness.setResponses([
				(_context, options) => {
					expect(resolveCursorAgentModelId(realModel, options)).toBe(expectedRoute);
					return fauxAssistantMessage("cursor child answer");
				},
			]);
			const result = await harness.session.runRlmChild("run Grok 4.6 xhigh", {
				thinking: "xhigh",
				...(fast === undefined ? {} : { fast }),
			});
			expect(result).toMatchObject({
				model: "cursor-not-cloud/cursor-grok-4.6-high",
				thinking: "xhigh",
				fast: expectedFast,
			});
		} finally {
			harness.cleanup();
		}
	});

	it("reports resolved thinking, rejects null fast, and rejects cloud targeting kwargs", async () => {
		const harness = await createHarness(cursorOptions);
		try {
			await harness.session.setModel(realModel);
			harness.setResponses([fauxAssistantMessage("clamped")]);
			const result = await harness.session.runRlmChild("clamp unsupported max", { thinking: "max" });
			expect(result.thinking).toBe("xhigh");
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

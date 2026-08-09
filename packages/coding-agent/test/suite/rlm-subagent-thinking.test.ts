import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { createHarness } from "./harness.js";

const provider = "faux-rlm-thinking";

describe("RLM subagent reasoning level", () => {
	it("inherits the parent reasoning level when none is requested", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model", reasoning: true }] });
		try {
			harness.session.setThinkingLevel("low");
			harness.setResponses([fauxAssistantMessage("inherited answer")]);

			const result = await harness.session.runRlmChild("inherit the parent level");

			expect(result.thinking).toBe("low");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.thinkingLevel).toBe("low");
			});
		} finally {
			harness.cleanup();
		}
	});

	it("runs a child at an explicitly requested reasoning level", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model", reasoning: true }] });
		try {
			harness.session.setThinkingLevel("low");
			harness.setResponses([fauxAssistantMessage("deep answer")]);

			const result = await harness.session.runRlmChild("think harder than your parent", { thinking: "high" });

			expect(result.thinking).toBe("high");
			// The override belongs to the child alone; the parent keeps thinking at its own level.
			expect(harness.session.thinkingLevel).toBe("low");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.thinkingLevel).toBe("high");
			});
		} finally {
			harness.cleanup();
		}
	});

	it("accepts a reasoning level through the kernel host handler", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model", reasoning: true }] });
		try {
			harness.setResponses([fauxAssistantMessage("kernel answer")]);
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			const run = handlers["rlm.run"];
			if (!run) throw new Error("Missing rlm.run host handler");

			const handle = (await run({ prompt: "spawn from the kernel", kwargs: { thinking: " Low " } })) as {
				thinking: string;
			};

			// Surrounding space and casing are normalized rather than rejected.
			expect(handle.thinking).toBe("low");
		} finally {
			harness.cleanup();
		}
	});

	it("clamps a requested level to what the child model supports", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model", reasoning: false }] });
		try {
			harness.setResponses([fauxAssistantMessage("clamped answer")]);

			const result = await harness.session.runRlmChild("ask for more than the model has", { thinking: "max" });

			// A non-reasoning model publishes no ladder to climb, so the handle reports the level the
			// child truly runs at instead of echoing a request the model cannot honor.
			expect(result.thinking).toBe("off");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.thinkingLevel).toBe("off");
			});
		} finally {
			harness.cleanup();
		}
	});

	it("rejects reasoning levels that are not on the ladder", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model", reasoning: true }] });
		try {
			await expect(harness.session.runRlmChild("bad level", { thinking: "ultra" })).rejects.toThrow(
				"rlm.run thinking must be one of: off, minimal, low, medium, high, xhigh, max",
			);
			await expect(harness.session.runRlmChild("bad type", { thinking: 3 })).rejects.toThrow(
				"rlm.run thinking must be a string",
			);
			await expect(harness.session.runRlmChild("bad kwarg", { reasoning: "high" })).rejects.toThrow(
				"Unsupported rlm.run kwargs: reasoning",
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});

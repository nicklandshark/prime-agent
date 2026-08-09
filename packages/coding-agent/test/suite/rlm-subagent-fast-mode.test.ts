import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness } from "./harness.js";

// supportsFastMode() is gated on provider + api + model id, so only a ChatGPT-shaped faux provider
// can ever resolve to the fast tier. gpt-5.3 is deliberately outside that allowlist.
const codexModels = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	models: [{ id: "gpt-5.4" }, { id: "gpt-5.3" }],
};

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("RLM subagent fast mode", () => {
	it("inherits the parent tier when fast is not requested", async () => {
		const harness = await createHarness(codexModels);
		try {
			harness.session.setServiceTier("priority");
			harness.setResponses([fauxAssistantMessage("inherited answer")]);

			const result = await harness.session.runRlmChild("inherit the parent tier");

			expect(result.fast).toBe(true);
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.serviceTier).toBe("priority");
			});
		} finally {
			harness.cleanup();
		}
	});

	it("gives a child the fast tier its parent is not on", async () => {
		const harness = await createHarness({ ...codexModels, persistSession: true });
		try {
			expect(harness.session.serviceTier).toBe("default");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("priority");
					return fauxAssistantMessage("fast answer");
				},
			]);

			const result = await harness.session.runRlmChild("run this one on the fast tier", { fast: true });

			expect(result.fast).toBe(true);
			// The child's tier is the child's alone: the parent stays off the fast tier, and the
			// user's saved default must not be rewritten behind their back.
			expect(harness.session.serviceTier).toBe("default");
			expect(harness.settingsManager.getDefaultServiceTier()).not.toBe("priority");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.serviceTier).toBe("priority");
			});
			const childSessions = await SessionManager.list(harness.tempDir, result.session_dir);
			const childSession = SessionManager.open(childSessions[0]!.path, result.session_dir);
			expect(childSession.buildSessionContext().serviceTier).toBe("priority");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a child off the fast tier its parent is paying for", async () => {
		const harness = await createHarness(codexModels);
		try {
			harness.session.setServiceTier("priority");
			harness.setResponses([
				(_context, options) => {
					expect(options?.serviceTier).toBe("default");
					return fauxAssistantMessage("cheap answer");
				},
			]);

			const result = await harness.session.runRlmChild("do not spend the fast tier here", { fast: false });

			expect(result.fast).toBe(false);
			expect(harness.session.serviceTier).toBe("priority");
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.serviceTier).toBe("default");
			});
		} finally {
			harness.cleanup();
		}
	});

	it("resolves a fast request against the child model, not the parent", async () => {
		const harness = await createHarness(codexModels);
		// Selecting a ChatGPT model for a child runs account catalog discovery, so publish both ids.
		const fetchModels = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.3" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey("openai-codex", openAICodexToken("account-1"));
			harness.setResponses([fauxAssistantMessage("clamped answer")]);

			const result = await harness.session.runRlmChild("ask a model without fast mode", {
				model: "openai-codex/gpt-5.3",
				fast: true,
			});

			// gpt-5.3 is outside the fast-mode allowlist, so the request resolves back to the normal
			// tier instead of failing the spawn or claiming a tier the child never got.
			expect(result.model).toBe("openai-codex/gpt-5.3");
			expect(result.fast).toBe(false);
			await vi.waitFor(() => {
				expect(harness.session.getRlmChildSession(result.rlm_child_id)?.serviceTier).toBe("default");
			});
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});

	it("accepts fast through the kernel host handler and rejects non-booleans", async () => {
		const harness = await createHarness(codexModels);
		try {
			harness.setResponses([fauxAssistantMessage("kernel answer")]);
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			const run = handlers["rlm.run"];
			if (!run) throw new Error("Missing rlm.run host handler");

			const handle = (await run({ prompt: "spawn from the kernel", kwargs: { fast: true } })) as {
				fast: boolean;
			};
			expect(handle.fast).toBe(true);

			await expect(run({ prompt: "bad type", kwargs: { fast: "priority" } })).rejects.toThrow(
				"rlm.run fast must be a boolean",
			);
			await expect(run({ prompt: "bad kwarg", kwargs: { service_tier: "priority" } })).rejects.toThrow(
				"Unsupported rlm.run kwargs: service_tier",
			);
		} finally {
			harness.cleanup();
		}
	});
});

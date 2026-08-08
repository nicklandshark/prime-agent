import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../harness.js";

const codexProvider = "openai-codex";

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("#1011 Luna subagent selection", () => {
	it("discovers and runs Luna from a Sol parent with Codex subscription auth", async () => {
		vi.stubEnv("RLM_DEPTH", "0");
		vi.stubEnv("RLM_MAX_DEPTH", "1");
		const harness = await createHarness({
			provider: codexProvider,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "gpt-5.6-luna", reasoning: true },
			],
		});
		const fetchModels = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			expect(harness.session.model?.id).toBe("gpt-5.6-sol");
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			const discovered = await harness.session.findRlmModels("luna", 8);
			expect(discovered.models.map((model) => model.selector)).toContain("openai-codex/gpt-5.6-luna");

			harness.setResponses([
				fauxAssistantMessage("Luna child completed"),
				fauxAssistantMessage("Terminal notice acknowledged"),
			]);
			const handle = await harness.session.runRlmChild("Run on Luna", {
				model: "openai-codex/gpt-5.6-luna",
			});
			expect(handle.model).toBe("openai-codex/gpt-5.6-luna");
			await vi.waitFor(async () => {
				const child = (await harness.session.listRlmSubagents()).subagents.find(
					(candidate) => candidate.rlm_child_id === handle.rlm_child_id,
				);
				expect(child?.status).toBe("completed");
			});
			const child = harness.session.getRlmChildSession(handle.rlm_child_id);
			expect(child?.model?.id).toBe("gpt-5.6-luna");
			expect(child?.getLastAssistantText()).toBe("Luna child completed");
			expect(fetchModels).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			harness.cleanup();
		}
	});

	it("does not fail open for a malformed non-empty Codex catalog", async () => {
		const harness = await createHarness({
			provider: codexProvider,
			models: [
				{ id: "gpt-5.6-sol", reasoning: true },
				{ id: "gpt-5.6-luna", reasoning: true },
			],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ models: [{ id: "gpt-5.6-luna" }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			const discovered = await harness.session.findRlmModels("luna", 8);
			expect(discovered.models.filter((model) => model.provider === codexProvider)).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});
});

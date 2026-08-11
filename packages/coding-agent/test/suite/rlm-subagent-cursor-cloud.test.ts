import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	normalizeRequestedRlmSubagentCursorAgentId,
	normalizeRequestedRlmSubagentCursorRepos,
	normalizeRequestedRlmSubagentCursorTunnel,
	type RlmCursorCloudTarget,
	type SubagentRuntimeHost,
	wrapRlmSubagentStreamFnWithCursorTarget,
} from "../../src/core/rlm-runtime.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

const CURSOR_API = "cursor-cloud-agents";
const AGENT_ID = "bc-66d015af-aaaa-4bbb-8ccc-dddddddddddd";
const REPO = "https://github.com/org/repo";

/** Options the cursor provider reads, as seen by a faux provider standing in for its api. */
type CapturedStreamOptions = StreamOptions & {
	agentId?: string;
	repos?: string[];
	tunnel?: boolean;
};

interface CapturedCall {
	context: Context;
	options: CapturedStreamOptions | undefined;
}

function isChildTaskCall(call: CapturedCall): boolean {
	return JSON.stringify(call.context.messages).includes("[task from parent]");
}

/** Register a faux provider for the cursor-cloud-agents api and capture the options it streams with. */
function captureCursorStreams(models: Array<{ id: string }> = [{ id: "cloud-agent" }]) {
	const calls: CapturedCall[] = [];
	const faux = registerFauxProvider({ api: CURSOR_API, provider: "cursor", models });
	faux.setResponses([
		(context, options) => {
			calls.push({ context, options: options as CapturedStreamOptions | undefined });
			return fauxAssistantMessage("cloud answer");
		},
	]);
	return { faux, calls };
}

/** Make cursor/cloud-agent resolvable for a session whose parent model is not a cursor model. */
function registerCursorCloudModel(harness: Harness): void {
	harness.authStorage.setRuntimeApiKey("cursor", "faux-cursor-key");
	const registry = (harness.session as unknown as { _modelRegistry: ModelRegistry })._modelRegistry;
	registry.registerProvider("cursor", {
		baseUrl: "http://localhost:0",
		apiKey: "faux-cursor-key",
		api: CURSOR_API,
		models: [
			{
				id: "cloud-agent",
				name: "Cursor Cloud Agent",
				api: CURSOR_API,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
		],
	});
}

describe("rlm.run cursor cloud kwarg normalizers", () => {
	it("accepts, trims, and rejects agent ids", () => {
		expect(normalizeRequestedRlmSubagentCursorAgentId(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmSubagentCursorAgentId(`  ${AGENT_ID}  `)).toBe(AGENT_ID);
		expect(() => normalizeRequestedRlmSubagentCursorAgentId(42)).toThrow("rlm.run agent_id must be a string");
		expect(() => normalizeRequestedRlmSubagentCursorAgentId("   ")).toThrow("rlm.run agent_id must not be empty");
		expect(() => normalizeRequestedRlmSubagentCursorAgentId("cloud-agent")).toThrow(
			'rlm.run agent_id must be a Cursor cloud agent id starting with "bc-"',
		);
	});

	it("accepts, trims, and rejects repo lists", () => {
		expect(normalizeRequestedRlmSubagentCursorRepos(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmSubagentCursorRepos([REPO, "  https://github.com/org/other  "])).toEqual([
			REPO,
			"https://github.com/org/other",
		]);
		expect(() => normalizeRequestedRlmSubagentCursorRepos(REPO)).toThrow(
			"rlm.run repos must be an array of GitHub repository URLs",
		);
		expect(() => normalizeRequestedRlmSubagentCursorRepos([42])).toThrow(
			"rlm.run repos must be an array of GitHub repository URLs",
		);
		expect(() => normalizeRequestedRlmSubagentCursorRepos([])).toThrow("rlm.run repos must not be empty");
		expect(() => normalizeRequestedRlmSubagentCursorRepos(["   "])).toThrow(
			"rlm.run repos must not contain empty entries",
		);
	});

	it("accepts and rejects tunnel flags", () => {
		expect(normalizeRequestedRlmSubagentCursorTunnel(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmSubagentCursorTunnel(true)).toBe(true);
		expect(normalizeRequestedRlmSubagentCursorTunnel(false)).toBe(false);
		expect(() => normalizeRequestedRlmSubagentCursorTunnel("yes")).toThrow("rlm.run tunnel must be a boolean");
	});
});

describe("wrapRlmSubagentStreamFnWithCursorTarget", () => {
	const cursorModel = { provider: "cursor", api: CURSOR_API, id: "cloud-agent" } as Model<never>;
	const context = { messages: [] } as unknown as Context;

	function wrap(target: RlmCursorCloudTarget) {
		const baseMock = vi.fn<(model: Model<never>, context: Context, options?: SimpleStreamOptions) => null>(
			() => null,
		);
		const wrapped = wrapRlmSubagentStreamFnWithCursorTarget(baseMock as unknown as StreamFn, target);
		return { baseMock, wrapped };
	}

	it("injects the target as provider options and metadata for cursor models", () => {
		const { baseMock, wrapped } = wrap({ agentId: AGENT_ID, repos: [REPO], tunnel: false });
		wrapped(cursorModel, context, { sessionId: "s-1" });
		expect(baseMock).toHaveBeenCalledWith(
			cursorModel,
			context,
			expect.objectContaining({
				sessionId: "s-1",
				agentId: AGENT_ID,
				repos: [REPO],
				tunnel: false,
				metadata: { cursorAgentId: AGENT_ID },
			}),
		);
	});

	it("merges cursorAgentId into existing metadata", () => {
		const { baseMock, wrapped } = wrap({ agentId: AGENT_ID });
		wrapped(cursorModel, context, { metadata: { other: "kept" } });
		expect(baseMock).toHaveBeenCalledWith(
			cursorModel,
			context,
			expect.objectContaining({ metadata: { other: "kept", cursorAgentId: AGENT_ID } }),
		);
	});

	it("omits absent target fields instead of overriding provider defaults", () => {
		const { baseMock, wrapped } = wrap({ repos: [REPO] });
		wrapped(cursorModel, context, { sessionId: "s-1" });
		const options = baseMock.mock.calls[0]![2]! as CapturedStreamOptions;
		expect(options.repos).toEqual([REPO]);
		expect(options).not.toHaveProperty("agentId");
		expect(options).not.toHaveProperty("tunnel");
		expect(options).not.toHaveProperty("metadata");
	});

	it("passes non-cursor models through untouched", () => {
		const { baseMock, wrapped } = wrap({ agentId: AGENT_ID, repos: [REPO], tunnel: true });
		const fauxModel = { provider: "faux", api: "faux", id: "faux-1" } as Model<never>;
		const options = { sessionId: "s-2" } as SimpleStreamOptions;
		wrapped(fauxModel, context, options);
		expect(baseMock).toHaveBeenCalledWith(fauxModel, context, options);
	});
});

describe("rlm.run cursor cloud spawn contract", () => {
	it("rejects cursor kwargs when the resolved child model is not a cursor model", async () => {
		const harness = await createHarness();
		try {
			await expect(harness.session.runRlmChild("fix the test", { agent_id: AGENT_ID })).rejects.toThrow(
				"require a cursor model",
			);
			await expect(harness.session.runRlmChild("fix the test", { repos: [REPO] })).rejects.toThrow(
				"require a cursor model",
			);
			await expect(harness.session.runRlmChild("fix the test", { tunnel: false })).rejects.toThrow(
				"require a cursor model",
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("still rejects unknown kwargs", async () => {
		const harness = await createHarness();
		try {
			await expect(harness.session.runRlmChild("fix the test", { agentId: AGENT_ID })).rejects.toThrow(
				"Unsupported rlm.run kwargs: agentId",
			);
			await expect(harness.session.runRlmChild("fix the test", { cursor_agent_id: AGENT_ID })).rejects.toThrow(
				"Unsupported rlm.run kwargs: cursor_agent_id",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("threads agent_id, repos, and tunnel to the cursor provider stream options", async () => {
		const harness = await createHarness({ api: CURSOR_API, provider: "cursor", models: [{ id: "cloud-agent" }] });
		const calls: CapturedCall[] = [];
		harness.setResponses([
			(context, options) => {
				calls.push({ context, options: options as CapturedStreamOptions | undefined });
				return fauxAssistantMessage("cloud answer");
			},
		]);
		try {
			const handle = await harness.session.runRlmChild("fix the test", {
				agent_id: AGENT_ID,
				repos: [REPO],
				tunnel: false,
			});

			expect(handle.model).toBe("cursor/cloud-agent");
			expect(handle.cursor_agent_id).toBe(AGENT_ID);
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.agentId).toBe(AGENT_ID);
			expect(childCall.options?.repos).toEqual([REPO]);
			expect(childCall.options?.tunnel).toBe(false);
			expect(childCall.options?.metadata?.cursorAgentId).toBe(AGENT_ID);
		} finally {
			harness.cleanup();
		}
	});

	it("spawns a fresh environment from repos alone, leaving provider defaults intact", async () => {
		const harness = await createHarness({ api: CURSOR_API, provider: "cursor", models: [{ id: "cloud-agent" }] });
		const calls: CapturedCall[] = [];
		harness.setResponses([
			(context, options) => {
				calls.push({ context, options: options as CapturedStreamOptions | undefined });
				return fauxAssistantMessage("cloud answer");
			},
		]);
		try {
			const handle = await harness.session.runRlmChild("build x", { repos: [REPO] });

			expect(handle).not.toHaveProperty("cursor_agent_id");
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.repos).toEqual([REPO]);
			expect(childCall.options).not.toHaveProperty("agentId");
			expect(childCall.options).not.toHaveProperty("tunnel");
			expect(childCall.options?.metadata?.cursorAgentId).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("resolves an explicit cursor model for a non-cursor parent and threads the target", async () => {
		const harness = await createHarness();
		const { faux, calls } = captureCursorStreams();
		registerCursorCloudModel(harness);
		try {
			const handle = await harness.session.runRlmChild("fix the test", {
				model: "cursor/cloud-agent",
				agent_id: AGENT_ID,
			});

			expect(handle.model).toBe("cursor/cloud-agent");
			expect(handle.cursor_agent_id).toBe(AGENT_ID);
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.agentId).toBe(AGENT_ID);
			expect(childCall.options?.metadata?.cursorAgentId).toBe(AGENT_ID);
		} finally {
			faux.unregister();
			harness.cleanup();
		}
	});

	it("accepts the new kwargs through the kernel host handler and rejects bad types", async () => {
		const harness = await createHarness({ api: CURSOR_API, provider: "cursor", models: [{ id: "cloud-agent" }] });
		harness.setResponses([fauxAssistantMessage("kernel answer")]);
		try {
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			const run = handlers["rlm.run"];
			if (!run) throw new Error("Missing rlm.run host handler");

			const handle = (await run({
				prompt: "spawn from the kernel",
				kwargs: { agent_id: AGENT_ID, repos: [REPO], tunnel: true },
			})) as { cursor_agent_id?: string };
			expect(handle.cursor_agent_id).toBe(AGENT_ID);

			await expect(run({ prompt: "bad type", kwargs: { tunnel: "yes" } })).rejects.toThrow(
				"rlm.run tunnel must be a boolean",
			);
			await expect(run({ prompt: "bad type", kwargs: { repos: REPO } })).rejects.toThrow(
				"rlm.run repos must be an array of GitHub repository URLs",
			);
			await expect(run({ prompt: "bad id", kwargs: { agent_id: "nope" } })).rejects.toThrow(
				'rlm.run agent_id must be a Cursor cloud agent id starting with "bc-"',
			);
			await expect(run({ prompt: "bad kwarg", kwargs: { agentId: AGENT_ID } })).rejects.toThrow(
				"Unsupported rlm.run kwargs: agentId",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("passes the cursor target to a hosted subagent runtime and wraps its stream", async () => {
		const { faux, calls } = captureCursorStreams();
		let capturedOptions: CreateRlmSubagentRuntimeOptions | undefined;
		let harness: Harness | undefined;
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (options) => {
				capturedOptions = options;
				const childAgent = new Agent({
					getApiKey: () => "faux-key",
					initialState: { model: options.model, systemPrompt: "child", tools: [] },
					convertToLlm,
				});
				const child = new AgentSession({
					agent: childAgent,
					sessionManager: SessionManager.inMemory(),
					settingsManager: SettingsManager.inMemory(),
					cwd: harness!.tempDir,
					resourceLoader: createTestResourceLoader(),
					modelRegistry: ModelRegistry.inMemory(harness!.authStorage),
				});
				return { session: child };
			},
			deleteRlmSubagentRuntime: async (_childId, session) => {
				await session?.disposeAsync();
			},
		};
		harness = await createHarness({ subagentRuntimeHost: host });
		registerCursorCloudModel(harness);
		try {
			const handle = await harness.session.runRlmChild("fix the test", {
				model: "cursor/cloud-agent",
				agent_id: AGENT_ID,
				tunnel: true,
			});

			expect(handle.cursor_agent_id).toBe(AGENT_ID);
			expect(capturedOptions?.cursor).toEqual({ agentId: AGENT_ID, tunnel: true });
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.agentId).toBe(AGENT_ID);
			expect(childCall.options?.tunnel).toBe(true);
			expect(childCall.options?.metadata?.cursorAgentId).toBe(AGENT_ID);
		} finally {
			faux.unregister();
			harness.cleanup();
		}
	});
});

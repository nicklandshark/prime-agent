import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider, streamSimpleCursor } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	normalizeRequestedRlmSubagentCursorEnvironment,
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
const ENVIRONMENT = "sedona-agent";
const REPO = "https://github.com/org/repo";

/** Options the cursor provider reads, as seen by a faux provider standing in for its api. */
type CapturedStreamOptions = StreamOptions & {
	environment?: string;
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
	it("accepts, trims, and rejects environment names", () => {
		expect(normalizeRequestedRlmSubagentCursorEnvironment(undefined)).toBeUndefined();
		expect(normalizeRequestedRlmSubagentCursorEnvironment(`  ${ENVIRONMENT}  `)).toBe(ENVIRONMENT);
		expect(() => normalizeRequestedRlmSubagentCursorEnvironment(42)).toThrow("rlm.run environment must be a string");
		expect(() => normalizeRequestedRlmSubagentCursorEnvironment("   ")).toThrow(
			"rlm.run environment must not be empty",
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

	it("injects a named environment on its own for cursor models", () => {
		const { baseMock, wrapped } = wrap({ environment: ENVIRONMENT });
		wrapped(cursorModel, context, { sessionId: "s-1" });
		expect(baseMock).toHaveBeenCalledWith(
			cursorModel,
			context,
			expect.objectContaining({ sessionId: "s-1", environment: ENVIRONMENT }),
		);
		const options = baseMock.mock.calls[0]![2]! as CapturedStreamOptions;
		expect(options).not.toHaveProperty("repos");
		expect(options).not.toHaveProperty("tunnel");
		expect(options).not.toHaveProperty("metadata");
	});

	it("drops repos and tunnel when a named environment is present", () => {
		const { baseMock, wrapped } = wrap({ environment: ENVIRONMENT, repos: [REPO], tunnel: true });
		wrapped(cursorModel, context, { sessionId: "s-1" });
		const options = baseMock.mock.calls[0]![2]! as CapturedStreamOptions;
		expect(options.environment).toBe(ENVIRONMENT);
		expect(options).not.toHaveProperty("repos");
		expect(options).not.toHaveProperty("tunnel");
	});

	it("injects repos and tunnel for an unnamed environment", () => {
		const { baseMock, wrapped } = wrap({ repos: [REPO], tunnel: false });
		wrapped(cursorModel, context, { sessionId: "s-1" });
		const options = baseMock.mock.calls[0]![2]! as CapturedStreamOptions;
		expect(options.repos).toEqual([REPO]);
		expect(options.tunnel).toBe(false);
		expect(options).not.toHaveProperty("environment");
		expect(options).not.toHaveProperty("metadata");
	});

	it("omits absent target fields instead of overriding provider defaults", () => {
		const { baseMock, wrapped } = wrap({ repos: [REPO] });
		wrapped(cursorModel, context, { sessionId: "s-1" });
		const options = baseMock.mock.calls[0]![2]! as CapturedStreamOptions;
		expect(options.repos).toEqual([REPO]);
		expect(options).not.toHaveProperty("environment");
		expect(options).not.toHaveProperty("tunnel");
		expect(options).not.toHaveProperty("metadata");
	});

	it("passes non-cursor models through untouched", () => {
		const { baseMock, wrapped } = wrap({ environment: ENVIRONMENT, repos: [REPO], tunnel: true });
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
			await expect(harness.session.runRlmChild("fix the test", { environment: ENVIRONMENT })).rejects.toThrow(
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

	it("rejects a cursor model spawn that omits the environment kwarg", async () => {
		const harness = await createHarness({ api: CURSOR_API, provider: "cursor", models: [{ id: "cloud-agent" }] });
		harness.setResponses([fauxAssistantMessage("cloud answer")]);
		try {
			await expect(harness.session.runRlmChild("fix the test", {})).rejects.toThrow(
				'rlm.run on a cursor cloud agent requires an environment kwarg (a named cloud environment, e.g. environment="sedona-agent")',
			);
			// repos alone no longer spawns: a named environment is required for cursor models.
			await expect(harness.session.runRlmChild("fix the test", { repos: [REPO] })).rejects.toThrow(
				"requires an environment kwarg",
			);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("still rejects unknown kwargs, including the removed agent_id", async () => {
		const harness = await createHarness();
		try {
			await expect(
				harness.session.runRlmChild("fix the test", { agent_id: "bc-66d015af-aaaa-4bbb-8ccc-dddddddddddd" }),
			).rejects.toThrow("Unsupported rlm.run kwargs: agent_id");
			await expect(harness.session.runRlmChild("fix the test", { cursor_environment: ENVIRONMENT })).rejects.toThrow(
				"Unsupported rlm.run kwargs: cursor_environment",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("threads environment to the cursor provider stream options", async () => {
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
				model: "cursor/cloud-agent",
				environment: ENVIRONMENT,
			});

			expect(handle.model).toBe("cursor/cloud-agent");
			expect(handle.cursor_environment).toBe(ENVIRONMENT);
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.environment).toBe(ENVIRONMENT);
			expect(childCall.options).not.toHaveProperty("repos");
			expect(childCall.options).not.toHaveProperty("tunnel");
			expect(childCall.options?.metadata?.cursorAgentId).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("drops repos and tunnel when environment is present", async () => {
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
				model: "cursor/cloud-agent",
				environment: ENVIRONMENT,
				repos: [REPO],
				tunnel: false,
			});

			expect(handle.cursor_environment).toBe(ENVIRONMENT);
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.environment).toBe(ENVIRONMENT);
			expect(childCall.options).not.toHaveProperty("repos");
			expect(childCall.options).not.toHaveProperty("tunnel");
		} finally {
			harness.cleanup();
		}
	});

	it("resolves an explicit cursor model for a non-cursor parent and threads the environment", async () => {
		const harness = await createHarness();
		const { faux, calls } = captureCursorStreams();
		registerCursorCloudModel(harness);
		try {
			const handle = await harness.session.runRlmChild("fix the test", {
				model: "cursor/cloud-agent",
				environment: ENVIRONMENT,
			});

			expect(handle.model).toBe("cursor/cloud-agent");
			expect(handle.cursor_environment).toBe(ENVIRONMENT);
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.environment).toBe(ENVIRONMENT);
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
				kwargs: { environment: ENVIRONMENT },
			})) as { cursor_environment?: string };
			expect(handle.cursor_environment).toBe(ENVIRONMENT);

			await expect(run({ prompt: "bad type", kwargs: { environment: 42 } })).rejects.toThrow(
				"rlm.run environment must be a string",
			);
			await expect(run({ prompt: "bad type", kwargs: { tunnel: "yes" } })).rejects.toThrow(
				"rlm.run tunnel must be a boolean",
			);
			await expect(run({ prompt: "bad type", kwargs: { repos: REPO } })).rejects.toThrow(
				"rlm.run repos must be an array of GitHub repository URLs",
			);
			await expect(run({ prompt: "bad kwarg", kwargs: { agent_id: "bc-nope" } })).rejects.toThrow(
				"Unsupported rlm.run kwargs: agent_id",
			);
			// The kernel path enforces the same required-environment contract for cursor models.
			await expect(run({ prompt: "missing env", kwargs: {} })).rejects.toThrow("requires an environment kwarg");
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
				environment: ENVIRONMENT,
			});

			expect(handle.cursor_environment).toBe(ENVIRONMENT);
			expect(capturedOptions?.cursor).toEqual({ environment: ENVIRONMENT });
			await vi.waitFor(() => {
				expect(calls.some(isChildTaskCall)).toBe(true);
			});
			const childCall = calls.find(isChildTaskCall)!;
			expect(childCall.options?.environment).toBe(ENVIRONMENT);
			expect(childCall.options).not.toHaveProperty("repos");
			expect(childCall.options).not.toHaveProperty("tunnel");
		} finally {
			faux.unregister();
			harness.cleanup();
		}
	});
});

describe("cursor provider environment mapping", () => {
	const model = {
		id: "composer-2.5",
		name: "Composer 2.5",
		api: CURSOR_API,
		provider: "cursor",
		baseUrl: "https://api.cursor.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as unknown as Model<"cursor-cloud-agents">;

	const context: Context = {
		messages: [{ role: "user", content: "do the thing", timestamp: Date.now() }],
	};

	interface CapturedRequest {
		url: string;
		method?: string;
		body?: Record<string, unknown>;
	}

	function stubCursorApi() {
		const requests: CapturedRequest[] = [];
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			requests.push({ url, method: init?.method, body });
			if (url.endsWith("/v1/agents") && init?.method === "POST") {
				return new Response(JSON.stringify({ agent: { id: "bc-test" }, run: { id: "run-1" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url.includes("/runs/run-1/stream")) {
				const sse = 'event: result\ndata: {"status":"FINISHED","text":"cloud answer"}\n\nevent: done\ndata: {}\n\n';
				return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
			}
			if (url.includes("/usage")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
		});
		return requests;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends env and omits repos on create when a named environment is set", async () => {
		const requests = stubCursorApi();
		const stream = streamSimpleCursor(model, context, {
			apiKey: "faux-cursor-key",
			environment: ENVIRONMENT,
			repos: [REPO],
			tunnel: false,
		} as SimpleStreamOptions);
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		const create = requests.find((request) => request.url.endsWith("/v1/agents") && request.method === "POST");
		expect(create).toBeDefined();
		expect(create!.body?.env).toEqual({ type: "cloud", name: ENVIRONMENT });
		expect(create!.body).not.toHaveProperty("repos");
	});

	it("sends repos and no env on create for an unnamed environment", async () => {
		const requests = stubCursorApi();
		const stream = streamSimpleCursor(model, context, {
			apiKey: "faux-cursor-key",
			repos: [REPO],
			tunnel: false,
		} as SimpleStreamOptions);
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		const create = requests.find((request) => request.url.endsWith("/v1/agents") && request.method === "POST");
		expect(create).toBeDefined();
		expect(create!.body?.repos).toEqual([{ url: REPO }]);
		expect(create!.body).not.toHaveProperty("env");
	});
});

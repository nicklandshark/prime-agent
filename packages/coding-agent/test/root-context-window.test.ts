/**
 * Root-only 1M effective context window for OpenAI Codex.
 *
 * The top-level agent plans OpenAI Codex models against 1,000,000 tokens while
 * the shared catalog, the model registry and every RLM subagent keep the raw
 * provider window. These tests pin both halves of that split and the
 * root-only injection gate that produces it.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	type ContextWindowOverrides,
	ROOT_OPENAI_CODEX_CONTEXT_WINDOW,
	rootContextWindowOverrides,
} from "../src/core/context-window.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { resolveRuntimeSessionOptions } from "../src/main.js";
import { createTestResourceLoader } from "./utilities.js";

/** Raw catalog windows the fork ships; asserted so a catalog change fails loudly here. */
const RAW_CODEX_WINDOW = 272_000;
const RAW_SPARK_WINDOW = 128_000;
const RAW_OPUS_WINDOW = 200_000;

const CODEX_MAX = getModel("openai-codex", "gpt-5.1-codex-max")!;
const CODEX_51 = getModel("openai-codex", "gpt-5.1")!;
const CODEX_SPARK = getModel("openai-codex", "gpt-5.3-codex-spark")!;
const OPUS = getModel("anthropic", "claude-opus-4-5")!;

const ROOT_OVERRIDES: ContextWindowOverrides = { "openai-codex": ROOT_OPENAI_CODEX_CONTEXT_WINDOW };

interface CompactionInternals {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<boolean>;
	_isRetryableError: (message: AssistantMessage) => boolean;
}

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function assistant(model: Model<any>, options: Partial<AssistantMessage> & { usage?: Usage } = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: options.usage ?? usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...options,
	} as AssistantMessage;
}

function streamAnswer(model: Model<any>, text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, { content: [{ type: "text", text }] });
		stream.push({ type: "start", partial: message });
		stream.end(message);
	});
	return stream;
}

const tempDirs: string[] = [];
const sessions: AgentSession[] = [];

function makeTempDir(): string {
	const dir = join(tmpdir(), `root-context-window-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

interface CreateSessionOptions {
	model?: Model<any>;
	contextWindowOverrides?: ContextWindowOverrides;
	persist?: boolean;
	rlmMaxDepth?: number;
	rlmSessionDir?: string;
	executableModels?: Model<any>[];
}

function createSession(options: CreateSessionOptions = {}): {
	session: AgentSession;
	modelRegistry: ModelRegistry;
	sessionManager: SessionManager;
	tempDir: string;
} {
	const tempDir = makeTempDir();
	const model = options.model ?? CODEX_MAX;
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("openai-codex", "test-key");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
	if (options.executableModels) {
		// ChatGPT's live per-account model discovery is a network call; the RLM
		// spawn path only needs the authenticated catalog it would have returned.
		vi.spyOn(modelRegistry, "getExecutableModels").mockResolvedValue(options.executableModels);
	}
	const sessionManager = options.persist
		? SessionManager.create(tempDir, join(tempDir, "sessions"))
		: SessionManager.inMemory();
	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		streamFn: (streamModel) => streamAnswer(streamModel, "child answer"),
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
		contextWindowOverrides: options.contextWindowOverrides,
		rlmDepth: 0,
		rlmMaxDepth: options.rlmMaxDepth,
		rlmSessionDir: options.rlmSessionDir,
	});
	sessions.push(session);
	return { session, modelRegistry, sessionManager, tempDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await sleep(10);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	while (sessions.length > 0) sessions.pop()?.dispose();
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
	}
});

describe("catalog windows stay raw", () => {
	it("does not rewrite the generated model catalog", () => {
		expect(CODEX_MAX.contextWindow).toBe(RAW_CODEX_WINDOW);
		expect(CODEX_51.contextWindow).toBe(RAW_CODEX_WINDOW);
		expect(CODEX_SPARK.contextWindow).toBe(RAW_SPARK_WINDOW);
		expect(OPUS.contextWindow).toBe(RAW_OPUS_WINDOW);
	});

	it("leaves the model registry reporting the raw window for a root session", () => {
		const { session, modelRegistry } = createSession({ contextWindowOverrides: ROOT_OVERRIDES });

		expect(session.effectiveContextWindow).toBe(ROOT_OPENAI_CODEX_CONTEXT_WINDOW);
		expect(modelRegistry.find("openai-codex", "gpt-5.1-codex-max")?.contextWindow).toBe(RAW_CODEX_WINDOW);
		expect(session.model?.contextWindow).toBe(RAW_CODEX_WINDOW);
	});
});

describe("rootContextWindowOverrides", () => {
	it("injects the 1M OpenAI Codex window only at rlmDepth 0", () => {
		expect(rootContextWindowOverrides(0)).toEqual({ "openai-codex": 1_000_000 });
		expect(rootContextWindowOverrides(undefined)).toEqual({ "openai-codex": 1_000_000 });
		expect(rootContextWindowOverrides(1)).toBeUndefined();
		expect(rootContextWindowOverrides(2)).toBeUndefined();
	});

	it("never travels through resolveRuntimeSessionOptions into a subagent runtime", () => {
		const resolved = resolveRuntimeSessionOptions(
			{ contextWindowOverrides: ROOT_OVERRIDES },
			{ rlmDepth: 1, contextWindowOverrides: ROOT_OVERRIDES },
		);

		expect(resolved.contextWindowOverrides).toBeUndefined();
		expect(Object.hasOwn(resolved, "contextWindowOverrides")).toBe(false);
	});
});

describe("AgentSession.effectiveContextWindow", () => {
	it("reports 1M for an OpenAI Codex root, whatever the model's raw window", () => {
		expect(createSession({ contextWindowOverrides: ROOT_OVERRIDES }).session.effectiveContextWindow).toBe(1_000_000);
		expect(
			createSession({ model: CODEX_SPARK, contextWindowOverrides: ROOT_OVERRIDES }).session.effectiveContextWindow,
		).toBe(1_000_000);
	});

	it("reports the raw window without an override (plain SDK sessions)", () => {
		expect(createSession().session.effectiveContextWindow).toBe(RAW_CODEX_WINDOW);
		expect(createSession({ model: CODEX_SPARK }).session.effectiveContextWindow).toBe(RAW_SPARK_WINDOW);
		expect(createSession({ model: OPUS }).session.effectiveContextWindow).toBe(RAW_OPUS_WINDOW);
	});

	it("follows /model across OpenAI Codex models and back off the provider", async () => {
		const { session } = createSession({ contextWindowOverrides: ROOT_OVERRIDES });
		expect(session.effectiveContextWindow).toBe(1_000_000);

		await session.setModel(CODEX_51);
		expect(session.effectiveContextWindow).toBe(1_000_000);

		await session.setModel(CODEX_SPARK);
		expect(session.effectiveContextWindow).toBe(1_000_000);

		await session.setModel(OPUS);
		expect(session.effectiveContextWindow).toBe(RAW_OPUS_WINDOW);

		await session.setModel(CODEX_MAX);
		expect(session.effectiveContextWindow).toBe(1_000_000);
	});

	it("ignores overrides for providers it was not given", async () => {
		const { session } = createSession({ model: OPUS, contextWindowOverrides: ROOT_OVERRIDES });
		expect(session.effectiveContextWindow).toBe(RAW_OPUS_WINDOW);

		await session.setModel(CODEX_MAX);
		expect(session.effectiveContextWindow).toBe(1_000_000);
	});
});

describe("getContextUsage", () => {
	it("reports the root window and percent for OpenAI Codex", () => {
		const { session, sessionManager } = createSession({ contextWindowOverrides: ROOT_OVERRIDES });
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage(assistant(CODEX_MAX, { usage: usage({ contextTokens: 250_000 }) }));

		const contextUsage = session.getContextUsage();
		expect(contextUsage?.contextWindow).toBe(1_000_000);
		expect(contextUsage?.tokens).toBe(250_000);
		expect(contextUsage?.percent).toBeCloseTo(25, 5);
		expect(session.handleCompactHostRequest("compact.status").context_window).toBe(1_000_000);
	});

	it("reports the raw window for the same branch without an override", () => {
		const { session, sessionManager } = createSession();
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage(assistant(CODEX_MAX, { usage: usage({ contextTokens: 250_000 }) }));

		expect(session.getContextUsage()?.contextWindow).toBe(RAW_CODEX_WINDOW);
	});

	it("does not let a stale provider-reported ceiling defeat the root override", async () => {
		const { session, sessionManager } = createSession({ model: OPUS, contextWindowOverrides: ROOT_OVERRIDES });
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		// A provider that reports its own ceiling answered before the /model switch.
		// That number belongs to the previous provider, so it must not outrank the
		// explicit session-local policy for the model now selected.
		sessionManager.appendMessage(
			assistant(OPUS, { usage: usage({ contextTokens: 120_000, contextMaxTokens: RAW_OPUS_WINDOW }) }),
		);
		expect(session.getContextUsage()?.contextWindow).toBe(RAW_OPUS_WINDOW);

		await session.setModel(CODEX_MAX);
		expect(session.getContextUsage()?.contextWindow).toBe(1_000_000);
	});

	it("still prefers the provider-reported ceiling when no override applies", () => {
		const { session, sessionManager } = createSession({ model: OPUS, contextWindowOverrides: ROOT_OVERRIDES });
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage(
			assistant(OPUS, { usage: usage({ contextTokens: 120_000, contextMaxTokens: 321_000 }) }),
		);

		expect(session.getContextUsage()?.contextWindow).toBe(321_000);
	});
});

describe("compaction, overflow and retry read the effective window", () => {
	async function checkCompaction(session: AgentSession, message: AssistantMessage) {
		const internals = session as unknown as CompactionInternals;
		const runAutoCompaction = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(true);
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			message,
		];
		await internals._checkCompaction(message, false);
		return runAutoCompaction;
	}

	it("treats a 300k-token turn as silent overflow at the raw window only", async () => {
		const overflowing = assistant(CODEX_MAX, {
			usage: usage({ input: 300_000, totalTokens: 300_000, contextTokens: 300_000 }),
		});

		const raw = await checkCompaction(createSession().session, overflowing);
		expect(raw).toHaveBeenCalledWith("overflow", true);

		const root = await checkCompaction(createSession({ contextWindowOverrides: ROOT_OVERRIDES }).session, {
			...overflowing,
		});
		expect(root).not.toHaveBeenCalled();
	});

	it("crosses the compaction threshold at the raw window only", async () => {
		// input stays small so this is a threshold decision, not a silent overflow.
		const large = assistant(CODEX_MAX, {
			usage: usage({ input: 1_000, totalTokens: 300_000, contextTokens: 300_000 }),
		});

		const raw = await checkCompaction(createSession().session, large);
		expect(raw).toHaveBeenCalledWith("threshold", false);

		const root = await checkCompaction(createSession({ contextWindowOverrides: ROOT_OVERRIDES }).session, {
			...large,
		});
		expect(root).not.toHaveBeenCalled();
	});

	it("keeps overflow errors non-retryable under both windows", () => {
		const overflowError = assistant(CODEX_MAX, {
			stopReason: "error",
			errorMessage: "This model's maximum context length is 272000 tokens",
		});
		const retryableError = assistant(CODEX_MAX, { stopReason: "error", errorMessage: "500 internal server error" });

		for (const overrides of [undefined, ROOT_OVERRIDES]) {
			const internals = createSession({ contextWindowOverrides: overrides })
				.session as unknown as CompactionInternals;
			expect(internals._isRetryableError(overflowError)).toBe(false);
			expect(internals._isRetryableError(retryableError)).toBe(true);
		}
	});
});

describe("RLM subagents keep the raw window", () => {
	it("gives an inherited child and an explicitly selected Codex child the raw window", async () => {
		const { session: root } = createSession({
			contextWindowOverrides: ROOT_OVERRIDES,
			persist: true,
			rlmMaxDepth: 2,
			executableModels: [CODEX_MAX, CODEX_51],
		});
		expect(root.effectiveContextWindow).toBe(1_000_000);

		const inherited = await root.runRlmChild("inherit the parent model");
		await waitFor(() => root.getRlmChildSession(inherited.rlm_child_id) !== undefined);
		const inheritedChild = root.getRlmChildSession(inherited.rlm_child_id)!;
		expect(inheritedChild.rlmDepth).toBe(1);
		expect(inheritedChild.model?.id).toBe(CODEX_MAX.id);
		expect(inheritedChild.effectiveContextWindow).toBe(RAW_CODEX_WINDOW);

		const explicit = await root.runRlmChild("pick a codex model", { model: "openai-codex/gpt-5.1" });
		await waitFor(() => root.getRlmChildSession(explicit.rlm_child_id) !== undefined);
		const explicitChild = root.getRlmChildSession(explicit.rlm_child_id)!;
		expect(explicitChild.model?.id).toBe(CODEX_51.id);
		expect(explicitChild.effectiveContextWindow).toBe(RAW_CODEX_WINDOW);

		// The root is unchanged by either spawn.
		expect(root.effectiveContextWindow).toBe(1_000_000);
	}, 30_000);
});

describe("/context reports separate windows per agent", () => {
	it("shows 1M for the root and the raw window for live and persisted children", async () => {
		const rlmSessionDir = makeTempDir();
		const { session: root, sessionManager } = createSession({
			contextWindowOverrides: ROOT_OVERRIDES,
			persist: true,
			rlmMaxDepth: 2,
			rlmSessionDir,
			executableModels: [CODEX_MAX],
		});
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage(assistant(CODEX_MAX, { usage: usage({ contextTokens: 400_000 }) }));

		// A completed child that only exists on disk; /context resolves its window
		// through the model registry, which is never overridden.
		const persistedDir = join(rlmSessionDir, "sub-deadbeef");
		mkdirSync(persistedDir, { recursive: true });
		const persisted = SessionManager.create(root.sessionManager.getCwd(), persistedDir);
		persisted.newSession({ rlmDepth: 1 });
		persisted.appendModelChange(CODEX_MAX.provider, CODEX_MAX.id);
		persisted.appendMessage({ role: "user", content: "persisted task", timestamp: Date.now() });
		persisted.appendMessage(assistant(CODEX_MAX, { usage: usage({ contextTokens: 12_000 }) }));
		persisted.flushNow();

		const spawned = await root.runRlmChild("live task");
		await waitFor(() => root.getRlmChildSession(spawned.rlm_child_id) !== undefined);
		const liveChild = root.getRlmChildSession(spawned.rlm_child_id)!;
		await waitFor(() => liveChild.getContextUsage() !== undefined);

		const tree = root.getContextTree();
		expect(tree.id).toBe("root");
		expect(tree.contextUsage?.contextWindow).toBe(1_000_000);
		expect(tree.contextUsage?.tokens).toBe(400_000);

		const live = tree.children.find((child) => child.id === spawned.rlm_child_id);
		expect(live?.contextUsage?.contextWindow).toBe(RAW_CODEX_WINDOW);

		const disk = tree.children.find((child) => child.id === "sub-deadbeef");
		expect(disk?.contextUsage?.contextWindow).toBe(RAW_CODEX_WINDOW);
		expect(disk?.contextUsage?.tokens).toBe(12_000);
	}, 30_000);
});

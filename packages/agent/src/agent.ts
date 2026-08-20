import {
	type AssistantMessage,
	type CursorExecHandlers,
	type CursorToolResultHandler,
	createAssistantMessageDiagnostic,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	streamSimple,
	type TextContent,
	type ThinkingBudgets,
	type ToolResultMessage,
	type Transport,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeToolCallContext,
	BeforeToolCallResult,
	GetContinuationMessagesContext,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.js";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

type QueueMode = "all" | "one-at-a-time";

type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		serviceTier: initialState?.serviceTier ?? "default",
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

export interface AgentOptions {
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	onPayload?: SimpleStreamOptions["onPayload"];
	onResponse?: SimpleStreamOptions["onResponse"];
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	shouldStopBeforeTurn?: () => boolean;
	getContinuationMessages?: (context: GetContinuationMessagesContext, signal?: AbortSignal) => Promise<AgentMessage[]>;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	sessionId?: string;
	thinkingBudgets?: ThinkingBudgets;
	transport?: Transport;
	maxRetryDelayMs?: number;
	toolExecution?: ToolExecutionMode;
	cursorExecHandlers?: CursorExecHandlers;
	cursorOnToolResult?: CursorToolResultHandler;
}

interface CursorToolResultEntry {
	toolResult: ToolResultMessage;
	pending?: Promise<void>;
}

export interface ExternalToolExecutionResult {
	result: AgentToolResult<unknown>;
	isError: boolean;
}

function externalToolError(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: {} };
}

async function raceExternalToolWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return await work;
	if (signal.aborted) {
		void work.catch(() => {});
		throw new Error("Tool execution aborted");
	}
	return await new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("Tool execution aborted"));
		signal.addEventListener("abort", abort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

class PendingMessageQueue {
	private batches: AgentMessage[][] = [];

	constructor(public mode: QueueMode) {}

	enqueue(message: AgentMessage | AgentMessage[]): void {
		const batch = Array.isArray(message) ? message.slice() : [message];
		if (batch.length > 0) {
			this.batches.push(batch);
		}
	}

	hasItems(): boolean {
		return this.batches.length > 0;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.batches.flat();
			this.batches = [];
			return drained;
		}

		const first = this.batches[0];
		if (!first) {
			return [];
		}
		this.batches = this.batches.slice(1);
		return first;
	}

	clear(): void {
		this.batches = [];
	}

	removeWhere(predicate: (message: AgentMessage) => boolean): AgentMessage[] {
		const removed: AgentMessage[] = [];
		const retained: AgentMessage[][] = [];
		for (const batch of this.batches) {
			if (batch.some(predicate)) {
				removed.push(...batch);
			} else {
				retained.push(batch);
			}
		}
		this.batches = retained;
		return removed;
	}
}

type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

export class Agent {
	private _state: MutableAgentState;
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;
	private readonly externalTools = new Map<string, AgentTool<any>>();

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	public streamFn: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	public onPayload?: SimpleStreamOptions["onPayload"];
	public onResponse?: SimpleStreamOptions["onResponse"];
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	public shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	public shouldStopBeforeTurn?: () => boolean;
	public getContinuationMessages?: (
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	) => Promise<AgentMessage[]>;
	private activeRun?: ActiveRun;
	public sessionId?: string;
	public thinkingBudgets?: ThinkingBudgets;
	public transport: Transport;
	public maxRetryDelayMs?: number;
	public toolExecution: ToolExecutionMode;
	private cursorExecHandlers?: CursorExecHandlers;
	private cursorOnToolResult?: CursorToolResultHandler;
	private cursorToolResultBuffer: CursorToolResultEntry[] = [];

	constructor(options: AgentOptions = {}) {
		this._state = createMutableAgentState(options.initialState);
		this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = options.transformContext;
		this.streamFn = options.streamFn ?? streamSimple;
		this.getApiKey = options.getApiKey;
		this.onPayload = options.onPayload;
		this.onResponse = options.onResponse;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		this.shouldStopBeforeTurn = options.shouldStopBeforeTurn;
		this.getContinuationMessages = options.getContinuationMessages;
		this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
		this.sessionId = options.sessionId;
		this.thinkingBudgets = options.thinkingBudgets;
		this.transport = options.transport ?? "auto";
		this.maxRetryDelayMs = options.maxRetryDelayMs;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.cursorExecHandlers = options.cursorExecHandlers;
		this.cursorOnToolResult = options.cursorOnToolResult;
	}

	/** Configure the Cursor Agent in-stream execution bridge for this session. */
	setCursorAgentBridge(handlers: CursorExecHandlers, onToolResult?: CursorToolResultHandler): void {
		this.cursorExecHandlers = handlers;
		this.cursorOnToolResult = onToolResult;
	}

	/** Register a hidden provider-owned AgentTool without advertising it to the model. */
	setExternalTool(tool: AgentTool<any>): void {
		this.externalTools.set(tool.name, tool);
	}

	/** Emit a provider-owned tool/message event through the normal Agent lifecycle. */
	async emitExternalEvent(event: AgentEvent): Promise<void> {
		await this.processEvents(event);
	}

	private externalToolInvocation(
		toolName: string,
		toolCallId: string,
		args: Record<string, unknown>,
	): {
		tool: AgentTool<any>;
		toolCall: AgentToolCall;
		assistantMessage: AssistantMessage;
		context: AgentContext;
		validatedArgs: unknown;
	} {
		const tool =
			this.externalTools.get(toolName) ?? this._state.tools.find((candidate) => candidate.name === toolName);
		if (!tool) throw new Error(`Tool ${toolName} not found`);
		let toolCall: AgentToolCall = { type: "toolCall", id: toolCallId, name: toolName, arguments: args };
		if (tool.prepareArguments) {
			toolCall = { ...toolCall, arguments: tool.prepareArguments(toolCall.arguments) as Record<string, unknown> };
		}
		const validatedArgs = validateToolArguments(tool, toolCall);
		const streaming = this._state.streamingMessage;
		const assistantMessage: AssistantMessage =
			streaming?.role === "assistant"
				? {
						...streaming,
						content: streaming.content.some((item) => item.type === "toolCall" && item.id === toolCallId)
							? streaming.content.map((item) =>
									item.type === "toolCall" && item.id === toolCallId ? toolCall : item,
								)
							: [...streaming.content, toolCall],
					}
				: {
						role: "assistant",
						content: [toolCall],
						api: this._state.model.api,
						provider: this._state.model.provider,
						model: this._state.model.id,
						usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
		const context: AgentContext = {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages,
			tools: [...this._state.tools, ...this.externalTools.values()],
		};
		return { tool, toolCall, assistantMessage, context, validatedArgs };
	}

	/** Ask the normal tool policy hook whether a provider-owned call may run. */
	async approveExternalTool(toolName: string, toolCallId: string, args: Record<string, unknown>): Promise<boolean> {
		try {
			const invocation = this.externalToolInvocation(toolName, toolCallId, args);
			if (!this.beforeToolCall) return true;
			const decision = await raceExternalToolWithAbort(
				this.beforeToolCall(
					{
						assistantMessage: invocation.assistantMessage,
						toolCall: invocation.toolCall,
						args: invocation.validatedArgs,
						context: invocation.context,
					},
					this.signal,
				),
				this.signal,
			);
			return decision?.block !== true;
		} catch {
			return false;
		}
	}

	/** Execute a provider-owned call through validation, policy, cancellation, and post hooks. */
	async executeExternalTool(
		toolName: string,
		toolCallId: string,
		args: Record<string, unknown>,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		skipBeforeToolCall = false,
		externalSignal?: AbortSignal,
	): Promise<ExternalToolExecutionResult> {
		const executionSignal =
			this.signal && externalSignal
				? AbortSignal.any([this.signal, externalSignal])
				: (externalSignal ?? this.signal);
		let invocation: ReturnType<Agent["externalToolInvocation"]>;
		try {
			invocation = this.externalToolInvocation(toolName, toolCallId, args);
			if (this.beforeToolCall && !skipBeforeToolCall) {
				const decision = await raceExternalToolWithAbort(
					this.beforeToolCall(
						{
							assistantMessage: invocation.assistantMessage,
							toolCall: invocation.toolCall,
							args: invocation.validatedArgs,
							context: invocation.context,
						},
						executionSignal,
					),
					executionSignal,
				);
				if (decision?.block) {
					return { result: externalToolError(decision.reason || "Tool execution was blocked"), isError: true };
				}
			}
		} catch (error) {
			return {
				result: externalToolError(error instanceof Error ? error.message : String(error)),
				isError: true,
			};
		}

		let result: AgentToolResult<unknown>;
		let isError = false;
		let acceptingUpdates = true;
		try {
			if (executionSignal?.aborted) throw new Error("Tool execution aborted");
			result = await raceExternalToolWithAbort(
				invocation.tool.execute(toolCallId, invocation.validatedArgs as never, executionSignal, (update) => {
					if (acceptingUpdates && !executionSignal?.aborted) onUpdate?.(update);
				}),
				executionSignal,
			);
		} catch (error) {
			result = externalToolError(error instanceof Error ? error.message : String(error));
			isError = true;
		} finally {
			acceptingUpdates = false;
		}
		if (this.afterToolCall) {
			try {
				const updated = await raceExternalToolWithAbort(
					this.afterToolCall(
						{
							assistantMessage: invocation.assistantMessage,
							toolCall: invocation.toolCall,
							args: invocation.validatedArgs,
							result,
							isError,
							context: invocation.context,
						},
						executionSignal,
					),
					executionSignal,
				);
				if (updated) {
					result = {
						content: updated.content ?? result.content,
						details: updated.details ?? result.details,
						terminate: updated.terminate ?? result.terminate,
					};
					isError = updated.isError ?? isError;
				}
			} catch (error) {
				result = externalToolError(error instanceof Error ? error.message : String(error));
				isError = true;
			}
		}
		return { result, isError };
	}

	/**
	 * Subscribe to agent lifecycle events.
	 *
	 * Listener promises are awaited in subscription order and are included in
	 * the current run's settlement. Listeners also receive the active abort
	 * signal for the current run.
	 *
	 * `agent_end` is the final emitted event for a run, but the agent does not
	 * become idle until all awaited listeners for that event have settled.
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Current agent state.
	 *
	 * Assigning `state.tools` or `state.messages` copies the provided top-level array.
	 */
	get state(): AgentState {
		return this._state;
	}

	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** Queue a message batch to be injected after the current assistant turn finishes. */
	steer(message: AgentMessage | AgentMessage[]): void {
		this.steeringQueue.enqueue(message);
	}

	/** Queue a message batch to run only after the agent would otherwise stop. */
	followUp(message: AgentMessage | AgentMessage[]): void {
		this.followUpQueue.enqueue(message);
	}

	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	removeQueuedMessages(predicate: (message: AgentMessage) => boolean): AgentMessage[] {
		return [...this.steeringQueue.removeWhere(predicate), ...this.followUpQueue.removeWhere(predicate)];
	}

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * Resolve when the current run and all awaited event listeners have finished.
	 *
	 * This resolves after `agent_end` listeners settle.
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	reset(): void {
		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/** The last message must convert to a user or tool-result message. */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const runQueuedMessages = (): Promise<void> | undefined => {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				return this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				return this.runPromptMessages(queuedFollowUps);
			}

			return undefined;
		};

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			const queuedRun = runQueuedMessages();
			if (queuedRun) {
				await queuedRun;
				return;
			}

			throw new Error("No messages to continue from");
		}

		if (lastMessage.role === "assistant") {
			const queuedRun = runQueuedMessages();
			if (queuedRun) {
				await queuedRun;
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		const lastMessageRole: string = lastMessage.role;
		if (lastMessageRole === "custom") {
			const queuedRun = runQueuedMessages();
			if (queuedRun) {
				await queuedRun;
				return;
			}
		}

		await this.runContinuation();
	}

	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFn,
			);
		});
	}

	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		// Cursor resolves exec-channel tools while the assistant message is still
		// streaming. Reserve each result synchronously, then persist it only after
		// the assistant message so transcript replay keeps call/result ordering.
		const cursorOnToolResult = async (message: ToolResultMessage) => {
			const entry: CursorToolResultEntry = { toolResult: message };
			this.cursorToolResultBuffer.push(entry);
			const transform = this.cursorOnToolResult;
			if (transform) {
				const pending = (async () => {
					try {
						const updated = await transform(message);
						if (updated) entry.toolResult = updated;
					} catch {
						// Keep the reserved original result when a rewrite hook fails.
					}
				})();
				entry.pending = pending;
				await pending;
				entry.pending = undefined;
			}
			return entry.toolResult;
		};
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel,
			serviceTier: this._state.serviceTier,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			cursorExecHandlers: this.cursorExecHandlers,
			cursorOnToolResult,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			shouldStopAfterTurn: async (context) => this.shouldStopAfterTurn?.(context) ?? false,
			shouldStopBeforeTurn: () => this.shouldStopBeforeTurn?.() ?? false,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getSystemPrompt: () => this._state.systemPrompt,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
			getContinuationMessages: async (context, signal) => this.getContinuationMessages?.(context, signal) ?? [],
		};
	}

	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		const abortController = new AbortController();
		let resolvePromise = () => {};
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		this._state.isStreaming = true;
		this.cursorToolResultBuffer = [];
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			diagnostics: aborted
				? undefined
				: [createAssistantMessageDiagnostic("agent_lifecycle_failure", error, { source: "run_with_lifecycle" })],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		this._state.errorMessage = failureMessage.errorMessage;
		await this.processEvents({ type: "message_start", message: failureMessage }).catch(() => undefined);
		await this.processEvents({ type: "message_end", message: failureMessage }).catch(() => undefined);
		await this.processEvents({ type: "agent_end", messages: [failureMessage] }).catch(() => undefined);
	}

	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * Reduce internal state for a loop event, then await listeners.
	 *
	 * `agent_end` only means no further loop events will be emitted. The run is
	 * considered idle later, after all awaited listeners for `agent_end` finish
	 * and `finishRun()` clears runtime-owned state.
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		let bufferedCursorResults: ToolResultMessage[] = [];
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				this._state.streamingMessage = undefined;
				if (event.message.role === "assistant" && this.cursorToolResultBuffer.length > 0) {
					const buffer = this.cursorToolResultBuffer;
					this.cursorToolResultBuffer = [];
					const pending = buffer.flatMap((entry) => (entry.pending ? [entry.pending] : []));
					if (pending.length > 0) await Promise.all(pending);
					bufferedCursorResults = buffer.map((entry) => entry.toolResult);
				}
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}

		// Persist provider-owned results after the assistant carrying their
		// synthesized calls. Recursive processing preserves normal lifecycle
		// events for storage/UI listeners without letting the agent loop execute
		// the calls a second time.
		for (const result of bufferedCursorResults) {
			await this.processEvents({ type: "message_start", message: result });
			await this.processEvents({ type: "message_end", message: result });
		}
	}
}

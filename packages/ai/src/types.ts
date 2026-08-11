import type {
	DeleteArgs,
	DeleteResult,
	DiagnosticsArgs,
	DiagnosticsResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	PiBashExecArgs,
	PiBashExecResult,
	PiEditExecArgs,
	PiEditExecResult,
	PiFindExecArgs,
	PiFindExecResult,
	PiGrepExecArgs,
	PiGrepExecResult,
	PiLsExecArgs,
	PiLsExecResult,
	PiReadExecArgs,
	PiReadExecResult,
	PiWriteExecArgs,
	PiWriteExecResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "./providers/cursor-agent/agent_pb.js";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "cursor-cloud-agents"
	| "cursor-agent";

export type Api = KnownApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "prime-inference"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "cursor"
	| "cursor-agent"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type Provider = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/** Token budgets for each thinking level (token-based providers only) */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
export type CacheRetention = "none" | "short" | "long";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | null;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * Providers that do not support this option ignore it.
	 */
	transport?: Transport;
	serviceTier?: ServiceTier;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * Default: "short".
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * Providers can use this to enable prompt caching, request routing, or other
	 * session-aware features. Ignored by providers that don't support it.
	 */
	sessionId?: string;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * its body stream is consumed.
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * Not supported by all providers (e.g., AWS Bedrock uses SDK auth).
	 */
	headers?: Record<string, string>;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** Custom token budgets for thinking levels (token-based providers only) */
	thinkingBudgets?: ThinkingBudgets;
	/** Cursor Agent exec handlers for in-stream Prime-owned tool execution. */
	cursorExecHandlers?: CursorExecHandlers;
	/** Receives Cursor exec-channel tool results for transcript persistence. */
	cursorOnToolResult?: CursorToolResultHandler;
}

// Generic StreamFunction with typed options.
//
// Contract:
// - Must return an AssistantMessageEventStream.
// - Once invoked, request/model/runtime failures should be encoded in the
//   returned stream, not thrown.
// - Error termination must produce an AssistantMessage with stopReason
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
}

export interface Usage {
	input: number;
	/** Provider-reported context usage when available. */
	contextTokens?: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	usage: Usage;
	stopReason: StopReason;
	stopReasonRaw?: string; // Provider's raw stop/finish reason when it mapped to "error" (e.g. "refusal", "SAFETY")
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number;
	ttft?: number;
	errorStatus?: number;
	errorId?: string;
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

/**
 * Optional rewrite of a Cursor exec-channel tool result.
 * May return a Promise. Returning `undefined` keeps the original result.
 *
 * The Agent reserves the original result in its buffer before awaiting this
 * hook, and the `message_end` drain waits for a still-pending rewrite, so an
 * async transformer is honored even when the turn closes in the same chunk.
 * A rejecting transformer is swallowed and the reserved payload stands in.
 */
export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

/**
 * Identifies the synthesized assistant block a Cursor exec call was filed
 * under, so paths that produce no handler `toolResult` can still pair one.
 */
export interface CursorExecPairing {
	toolCallId: string;
	toolName: string;
}

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;
	/**
	 * The frame asks only whether this call would be permitted — it must not
	 * run. The server sends it to resolve a smart-mode approval decision ahead
	 * of the real invocation, and answers with the dedicated `approved`
	 * variant, so executing here would fire a side-effecting tool the user has
	 * not yet been asked about (and fire it twice once the real call arrives).
	 */
	approvalOnly?: boolean;
}

export interface CursorTodoSnapshotItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

/**
 * Authoritative todo list state settled by Cursor's server-side
 * `update_todos` / `read_todos` tools.
 */
export interface CursorTodoSnapshot {
	todos: CursorTodoSnapshotItem[];
	/** True when the server reported the update as a merge. Presentation only. */
	merged: boolean;
}

/**
 * Settles a native todo call in the host.
 *
 * Called for every completed native todo call, not just successful ones: the
 * interactive todo card only resolves on a matching `tool_execution_end`, so a
 * refused or failed call that stayed silent would animate forever.
 *
 * `snapshot` is the server-confirmed list, or `null` when there is nothing to
 * mirror — a server error (`error` set), or a benign refusal with `error` null:
 * a filtered, truncated, or empty read, or a snapshot the local model cannot
 * represent (two rows sharing content). Local state MUST be left untouched
 * unless a snapshot is supplied.
 *
 * `toolCallId` is the id of the streamed native call, which is also the key the
 * interactive transcript filed the visible block under. The host MUST reuse it
 * when emitting the synthetic completion, or that block never resolves.
 *
 * Returns the result to persist for that block — always, since every settle
 * needs a paired result or `buildSessionContext` strips the block as dangling.
 * Only the host knows the phase grouping the todo renderer replays from, so the
 * provider persists this value verbatim. When no handler is registered at all,
 * the provider falls back to its own summary-only result.
 */
export type CursorTodoSyncHandler = (
	snapshot: CursorTodoSnapshot | null,
	toolCallId: string,
	error: string | null,
) => ToolResultMessage;

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

/**
 * A modern Pi exec frame plus the call id the dispatcher minted for it.
 *
 * Unlike the legacy exec args (`ReadArgs`, `ShellArgs`, ...), the Pi frames
 * carry no `tool_call_id` field: on modern builds the id rides the streamed
 * `ToolCall` envelope (`ToolCall.tool_call_id = 57`) instead of each variant's
 * args. The exec channel has no access to that envelope, so the dispatcher
 * mints an id and hands it to the handler, keeping the synthesized transcript
 * block and its paired `toolResult` on the same key.
 */
export interface CursorPiCall<TArgs> {
	args: TArgs;
	toolCallId: string;
}

/** One resource a host's MCP servers advertise. */
export interface CursorMcpResource {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	/** The server advertising it; Cursor addresses reads by this name. */
	server: string;
}

/**
 * The content of one resource read.
 *
 * `text` and `blob` are the wire's content oneof: exactly one is sent, with
 * `text` winning when a host supplies both. A download instead sets
 * `downloadPath` and no content at all — the model is told where the file
 * landed rather than being handed its bytes.
 */
export interface CursorMcpResourceContent {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
	text?: string;
	blob?: Uint8Array;
	/**
	 * Where the host wrote the resource, workspace-relative, when the frame
	 * asked for a download. Set this INSTEAD of `text`/`blob`: the wire
	 * contract is that a download returns no content to the model.
	 */
	downloadPath?: string;
}

export interface CursorExecHandlerContext {
	/** Abort only this provider-owned execution, without cancelling the whole turn. */
	signal?: AbortSignal;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	diagnostics?: (
		args: DiagnosticsArgs,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<DiagnosticsResult>>;
	mcp?: (call: CursorMcpCall, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<McpResult>>;
	/**
	 * Answers "would this MCP call be permitted", without running it.
	 *
	 * A modern `mcpArgs` frame carrying `smart_mode_approval_only` asks for the
	 * permission decision alone, ahead of the real invocation. Executing the
	 * tool to answer it would fire a side effect the user never approved — and
	 * fire it twice once the real call arrives.
	 *
	 * `true` only when the host's policy resolves to a definite allow. A pending
	 * prompt is `false`: it can only be answered interactively at execution
	 * time, and there is no "ask me later" reply in this frame's result. When no
	 * handler is registered the provider refuses, since it cannot decide.
	 */
	mcpApprovalPreflight?: (call: CursorMcpCall, context?: CursorExecHandlerContext) => Promise<boolean>;
	/**
	 * Modern Cursor CLI Pi tool frames (`ExecServerMessage` 45-51). They are a
	 * distinct frame family from the legacy `readArgs`/`shellArgs`/... set, not
	 * an alias: different args, different result oneofs, and no `tool_call_id`.
	 */
	piRead?: (
		call: CursorPiCall<PiReadExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiReadExecResult>>;
	piBash?: (
		call: CursorPiCall<PiBashExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiBashExecResult>>;
	piEdit?: (
		call: CursorPiCall<PiEditExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiEditExecResult>>;
	piWrite?: (
		call: CursorPiCall<PiWriteExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiWriteExecResult>>;
	piGrep?: (
		call: CursorPiCall<PiGrepExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiGrepExecResult>>;
	piFind?: (
		call: CursorPiCall<PiFindExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiFindExecResult>>;
	piLs?: (
		call: CursorPiCall<PiLsExecArgs>,
		context?: CursorExecHandlerContext,
	) => Promise<CursorExecHandlerResult<PiLsExecResult>>;
	/**
	 * The resources the host's MCP servers advertise, optionally filtered to one
	 * server. Without a handler the provider answers an empty catalog, which
	 * hides resources a host is in fact holding live connections to.
	 */
	listMcpResources?: (args: { server?: string }, context?: CursorExecHandlerContext) => Promise<CursorMcpResource[]>;
	/**
	 * Read one resource. `null` means the server or uri is genuinely unknown,
	 * which the provider answers as `not_found`; throwing surfaces as `error`.
	 */
	readMcpResource?: (
		args: {
			server: string;
			uri: string;
			/**
			 * When set, write the resource here (workspace-relative) and return
			 * `downloadPath` instead of content.
			 */
			downloadPath?: string;
		},
		context?: CursorExecHandlerContext,
	) => Promise<CursorMcpResourceContent | null>;
	/** Mirror Cursor's server-owned todo list into local session state. */
	todoSync?: CursorTodoSyncHandler;
	onToolResult?: CursorToolResultHandler;
}

import type { TSchema } from "typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompletionsCompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "deepseek" uses thinking: { type } plus reasoning_effort, "zai" uses top-level enable_thinking: boolean, "qwen" uses top-level enable_thinking: boolean, and "qwen-chat-template" uses chat_template_kwargs.enable_thinking. Default: "openai". */
	thinkingFormat?: "openai" | "openrouter" | "deepseek" | "zai" | "qwen" | "qwen-chat-template";
	/** OpenRouter-specific routing preferences. Only used when baseUrl points to OpenRouter. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
	zaiToolStream?: boolean;
	/** Whether the provider supports the `strict` field in tool definitions. Default: true. */
	supportsStrictMode?: boolean;
	/** Cache control convention for prompt caching. "anthropic" applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user/assistant text content. */
	cacheControlFormat?: "anthropic";
	/** Whether to send known session-affinity headers (`session_id`, `x-client-request-id`, `x-session-affinity`) from `options.sessionId` when caching is enabled. Default: false. */
	sendSessionAffinityHeaders?: boolean;
	/** Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"` or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. */
	supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat {
	/** Whether to send the OpenAI `session_id` cache-affinity header from `options.sessionId` when caching is enabled. Default: true. */
	sendSessionIdHeader?: boolean;
	/** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
	supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat {
	/**
	 * Whether the provider accepts per-tool `eager_input_streaming`.
	 * When false, the Anthropic provider omits `tools[].eager_input_streaming`
	 * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
	 * for tool-enabled requests.
	 * Default: true.
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
	supportsLongCacheRetention?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 * Sent as the `provider` field in the OpenRouter API request body.
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
	/** Whether to allow backup providers to serve requests. Default: true. */
	allow_fallbacks?: boolean;
	/** Whether to filter providers to only those that support all parameters in the request. Default: false. */
	require_parameters?: boolean;
	/** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
	data_collection?: "deny" | "allow";
	/** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
	zdr?: boolean;
	/** Whether to restrict routing to only models that allow text distillation. */
	enforce_distillable_text?: boolean;
	/** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
	order?: string[];
	/** List of provider names/slugs to exclusively allow for this request. */
	only?: string[];
	/** List of provider names/slugs to skip for this request. */
	ignore?: string[];
	/** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
	quantizations?: string[];
	/** Sorting strategy. Can be a string (e.g., "price", "throughput", "latency") or an object with `by` and `partition`. */
	sort?:
		| string
		| {
				/** The sorting metric: "price", "throughput", "latency". */
				by?: string;
				/** Partitioning strategy: "model" (default) or "none". */
				partition?: string | null;
		  };
	/** Maximum price per million tokens (USD). */
	max_price?: {
		/** Price per million prompt tokens. */
		prompt?: number | string;
		/** Price per million completion tokens. */
		completion?: number | string;
		/** Price per image. */
		image?: number | string;
		/** Price per audio unit. */
		audio?: number | string;
		/** Price per request. */
		request?: number | string;
	};
	/** Preferred minimum throughput (tokens/second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_min_throughput?:
		| number
		| {
				/** Minimum tokens/second at the 50th percentile. */
				p50?: number;
				/** Minimum tokens/second at the 75th percentile. */
				p75?: number;
				/** Minimum tokens/second at the 90th percentile. */
				p90?: number;
				/** Minimum tokens/second at the 99th percentile. */
				p99?: number;
		  };
	/** Preferred maximum latency (seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_max_latency?:
		| number
		| {
				/** Maximum latency in seconds at the 50th percentile. */
				p50?: number;
				/** Maximum latency in seconds at the 75th percentile. */
				p75?: number;
				/** Maximum latency in seconds at the 90th percentile. */
				p90?: number;
				/** Maximum latency in seconds at the 99th percentile. */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

// Model interface for the unified model system
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: Provider;
	baseUrl: string;
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Concrete Cursor wire model selected from a logical reasoning route. */
	requestModelId?: string;
	/** Cursor's independent max-mode flag; distinct from reasoning effort. */
	cursorMaxMode?: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	contextWindow: number;
	maxTokens: number;
	/** Flagship model surfaced above non-featured models of the same provider in pickers. */
	featured?: boolean;
	headers?: Record<string, string>;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}

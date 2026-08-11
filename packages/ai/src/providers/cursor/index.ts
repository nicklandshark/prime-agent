import { getEnvApiKey } from "../../env-api-keys.js";
import { calculateCost } from "../../models.js";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
} from "../../types.js";
import { AssistantMessageEventStream } from "../../utils/event-stream.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";
import { recordStreamFailure } from "../../utils/stream-failure.js";
import { buildBaseOptions } from "../simple-options.js";
import { CURSOR_TUNNEL_PREAMBLE } from "./tunnel-preamble.js";

export { CURSOR_TUNNEL_PREAMBLE } from "./tunnel-preamble.js";

const CURSOR_AGENT_ID_PREFIX = "bc-";
const MAX_PROMPT_IMAGES = 5;

/**
 * Provider-specific options for the Cursor Cloud Agents API.
 *
 * Each completion spawns (or resumes) a Cursor cloud agent run; the cloud
 * agent has its own harness, system prompt, and tools, so the local system
 * prompt and tool definitions are deliberately not forwarded.
 */
export interface CursorOptions extends StreamOptions {
	/** Existing cloud agent id (`bc-...`) to send this turn to as a follow-up run. */
	agentId?: string;
	/**
	 * Named cloud environment to create the new agent in (`env: {type: "cloud", name}`).
	 * The environment has its repos baked in, so it is mutually exclusive with `repos`:
	 * when set, `repos` is dropped.
	 */
	environment?: string;
	/** GitHub repo URLs cloned into the cloud VM when creating a new agent. Overrides CURSOR_CLOUD_REPO(S). Ignored when `environment` is set. */
	repos?: string[];
	/** Prepend CURSOR_TUNNEL_PREAMBLE to the first prompt of newly created agents. Default: true (CURSOR_CLOUD_TUNNEL=0 disables). */
	tunnel?: boolean;
	/** Tailscale auth key forwarded into the cloud VM as TAILSCALE_AUTHKEY. Default: local TAILSCALE_AUTHKEY env var. */
	tailscaleAuthKey?: string;
}

interface CursorTokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
}

interface CursorSseEvent {
	event: string;
	data: string;
	id?: string;
}

class CursorApiRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "CursorApiRequestError";
	}
}

// Maps prime-agent session ids to the cloud agent created for them, so
// follow-up turns within a session continue the same cloud conversation.
const sessionAgents = new Map<string, string>();

export const streamCursor: StreamFunction<"cursor-cloud-agents", CursorOptions> = (
	model: Model<"cursor-cloud-agents">,
	context: Context,
	options?: CursorOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output = createOutput(model);
		let activeRun: { agentId: string; runId: string } | undefined;

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const userMessage = extractLastUserMessage(context.messages);
			if (!userMessage || (!userMessage.text.trim() && userMessage.images.length === 0)) {
				throw new Error("Cursor cloud agents require a non-empty user message");
			}

			const client = new CursorCloudClient(model, apiKey, options);
			let agentId = resolveAgentId(options);
			let runId: string | undefined;

			if (agentId) {
				try {
					runId = await client.createFollowUpRun(agentId, userMessage);
				} catch (error) {
					// The referenced agent is gone (deleted/expired server-side): start fresh.
					if (error instanceof CursorApiRequestError && error.status === 404) {
						agentId = undefined;
					} else {
						throw error;
					}
				}
			}

			if (!agentId) {
				const environment = resolveEnvironment(options);
				// A named cloud environment has its repos baked in, so it is mutually
				// exclusive with repos: environment wins and repos are dropped.
				const repos = environment ? [] : resolveRepos(options);
				if (!environment && repos.length === 0) {
					throw new Error(
						"No repository configured for Cursor cloud agents. Set CURSOR_CLOUD_REPO to a full GitHub URL " +
							"(e.g. https://github.com/org/repo) or CURSOR_CLOUD_REPOS (comma-separated), pass repos via " +
							"provider options, or target a named cloud environment via the environment option.",
					);
				}
				const created = await client.createAgent(userMessage, repos, resolveTunnelEnabled(options), environment);
				agentId = created.agentId;
				runId = created.runId;
			}

			if (!runId) {
				throw new Error("Cursor Cloud Agents API did not return a run id");
			}
			activeRun = { agentId, runId };
			if (options?.sessionId) {
				sessionAgents.set(options.sessionId, agentId);
			}

			output.responseId = `${agentId}/${runId}`;
			stream.push({ type: "start", partial: output });

			const terminal = await client.streamRun(agentId, runId, output, stream);
			if (terminal.error) {
				throw new Error(
					`Cursor cloud run failed${terminal.error.code ? ` (${terminal.error.code})` : ""}: ${terminal.error.message ?? "unknown error"}`,
				);
			}
			if (terminal.status && terminal.status !== "FINISHED") {
				throw new Error(`Cursor cloud run ${runId} ended with status ${terminal.status}`);
			}

			await client.populateUsage(agentId, runId, output);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			if (options?.signal?.aborted && activeRun) {
				await cancelRunQuietly(model, options, activeRun);
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Maps provider-agnostic `SimpleStreamOptions` to Cursor options.
 */
export const streamSimpleCursor: StreamFunction<"cursor-cloud-agents", SimpleStreamOptions> = (
	model: Model<"cursor-cloud-agents">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const cursorOptions = options as CursorOptions | undefined;
	return streamCursor(model, context, {
		...buildBaseOptions(model, options),
		agentId: cursorOptions?.agentId,
		environment: cursorOptions?.environment,
		repos: cursorOptions?.repos,
		tunnel: cursorOptions?.tunnel,
		tailscaleAuthKey: cursorOptions?.tailscaleAuthKey,
	});
};

function createOutput(model: Model<"cursor-cloud-agents">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface CursorUserMessage {
	text: string;
	images: ImageContent[];
}

function extractLastUserMessage(messages: Message[]): CursorUserMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;
		if (typeof msg.content === "string") {
			return { text: sanitizeSurrogates(msg.content), images: [] };
		}
		const text = msg.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const images = msg.content.filter((part): part is ImageContent => part.type === "image");
		return { text: sanitizeSurrogates(text), images };
	}
	return undefined;
}

function resolveAgentId(options?: CursorOptions): string | undefined {
	const fromMetadata = options?.metadata?.cursorAgentId;
	const agentId = options?.agentId ?? (typeof fromMetadata === "string" ? fromMetadata : undefined);
	if (agentId) {
		if (!agentId.startsWith(CURSOR_AGENT_ID_PREFIX)) {
			throw new Error(`Invalid Cursor cloud agent id "${agentId}" (expected ${CURSOR_AGENT_ID_PREFIX}...)`);
		}
		return agentId;
	}
	if (options?.sessionId) {
		return sessionAgents.get(options.sessionId);
	}
	return undefined;
}

function resolveEnvironment(options?: CursorOptions): string | undefined {
	const environment = options?.environment?.trim();
	return environment ? environment : undefined;
}

function resolveRepos(options?: CursorOptions): string[] {
	if (options?.repos?.length) return options.repos;
	const multi = process.env.CURSOR_CLOUD_REPOS?.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (multi?.length) return multi;
	const single = process.env.CURSOR_CLOUD_REPO?.trim();
	return single ? [single] : [];
}

function resolveTunnelEnabled(options?: CursorOptions): boolean {
	if (options?.tunnel !== undefined) return options.tunnel;
	const raw = process.env.CURSOR_CLOUD_TUNNEL?.trim().toLowerCase();
	if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
	return true;
}

async function cancelRunQuietly(
	model: Model<"cursor-cloud-agents">,
	options: CursorOptions | undefined,
	run: { agentId: string; runId: string },
): Promise<void> {
	try {
		const apiKey = options?.apiKey || getEnvApiKey(model.provider);
		if (!apiKey) return;
		const client = new CursorCloudClient(model, apiKey, options);
		await client.cancelRun(run.agentId, run.runId);
	} catch {
		// Best-effort cancellation; the run may already be terminal.
	}
}

class CursorCloudClient {
	constructor(
		private readonly model: Model<"cursor-cloud-agents">,
		private readonly apiKey: string,
		private readonly options?: CursorOptions,
	) {}

	async createAgent(
		message: CursorUserMessage,
		repos: string[],
		tunnel: boolean,
		environment?: string,
	): Promise<{ agentId: string; runId: string }> {
		const promptText = tunnel ? `${CURSOR_TUNNEL_PREAMBLE}\n${message.text}` : message.text;
		const body: Record<string, unknown> = {
			prompt: buildPrompt(promptText, message.images),
			autoCreatePR: false,
			skipReviewerRequest: true,
		};
		// env and repos are mutually exclusive: a named cloud environment already
		// has its repos baked in, so repos are only sent for unnamed environments.
		if (environment) {
			body.env = { type: "cloud", name: environment };
		} else {
			body.repos = repos.map((url) => ({ url }));
		}
		// "cloud-agent" is the logical id for the account's server-resolved default model.
		if (this.model.id !== "cloud-agent") {
			body.model = { id: this.model.id };
		}
		const authKey = this.options?.tailscaleAuthKey ?? process.env.TAILSCALE_AUTHKEY;
		if (authKey) {
			body.envVars = { TAILSCALE_AUTHKEY: authKey };
		}

		const response = await this.request<{ agent?: { id?: string }; run?: { id?: string } }>(
			"POST",
			"/v1/agents",
			await this.applyPayloadHook(body),
		);
		const agentId = response.agent?.id;
		const runId = response.run?.id;
		if (!agentId || !runId) {
			throw new Error("Cursor Cloud Agents API returned an incomplete create response");
		}
		return { agentId, runId };
	}

	async createFollowUpRun(agentId: string, message: CursorUserMessage): Promise<string> {
		const body: Record<string, unknown> = { prompt: buildPrompt(message.text, message.images) };
		const response = await this.request<{ run?: { id?: string } }>(
			"POST",
			`/v1/agents/${agentId}/runs`,
			await this.applyPayloadHook(body),
		);
		if (!response.run?.id) {
			throw new Error("Cursor Cloud Agents API returned an incomplete run response");
		}
		return response.run.id;
	}

	async streamRun(
		agentId: string,
		runId: string,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
	): Promise<{ status?: string; error?: { code?: string; message?: string } }> {
		const response = await this.rawRequest("GET", `/v1/agents/${agentId}/runs/${runId}/stream`, undefined, {
			accept: "text/event-stream",
		});

		let currentBlock: TextContent | ThinkingContent | null = null;
		const blockIndex = () => output.content.length - 1;
		let streamedText = false;
		let status: string | undefined;
		let resultText: string | undefined;
		let streamError: { code?: string; message?: string } | undefined;

		const finishCurrentBlock = () => {
			if (!currentBlock) return;
			if (currentBlock.type === "text") {
				stream.push({ type: "text_end", contentIndex: blockIndex(), content: currentBlock.text, partial: output });
			} else {
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				});
			}
			currentBlock = null;
		};

		const appendDelta = (kind: "text" | "thinking", delta: string) => {
			const sanitized = sanitizeSurrogates(delta);
			if (!sanitized) return;
			if (!currentBlock || currentBlock.type !== kind) {
				finishCurrentBlock();
				currentBlock = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				stream.push({
					type: kind === "text" ? "text_start" : "thinking_start",
					contentIndex: blockIndex(),
					partial: output,
				});
			}
			if (currentBlock.type === "text") {
				currentBlock.text += sanitized;
				streamedText = true;
				stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: sanitized, partial: output });
			} else {
				currentBlock.thinking += sanitized;
				stream.push({ type: "thinking_delta", contentIndex: blockIndex(), delta: sanitized, partial: output });
			}
		};

		for await (const event of parseSse(response)) {
			if (event.event === "assistant") {
				const payload = parseEventData<{ text?: unknown }>(event);
				if (typeof payload?.text === "string") appendDelta("text", payload.text);
			} else if (event.event === "thinking") {
				const payload = parseEventData<{ text?: unknown }>(event);
				if (typeof payload?.text === "string") appendDelta("thinking", payload.text);
			} else if (event.event === "result") {
				const payload = parseEventData<{ status?: unknown; text?: unknown }>(event);
				if (typeof payload?.status === "string") status = payload.status;
				if (typeof payload?.text === "string") resultText = payload.text;
			} else if (event.event === "status") {
				const payload = parseEventData<{ status?: unknown }>(event);
				if (typeof payload?.status === "string" && isTerminalRunStatus(payload.status)) {
					status = payload.status;
				}
			} else if (event.event === "error") {
				const payload = parseEventData<{ code?: unknown; message?: unknown }>(event);
				streamError = {
					code: typeof payload?.code === "string" ? payload.code : undefined,
					message: typeof payload?.message === "string" ? payload.message : undefined,
				};
			} else if (event.event === "done") {
				break;
			}
			// heartbeat, tool_call, interaction_update: the cloud agent's tool calls
			// execute remotely, so they must never enter the local tool loop.
		}

		finishCurrentBlock();
		if (!streamedText && resultText) {
			appendDelta("text", resultText);
			finishCurrentBlock();
		}
		return { status, error: streamError };
	}

	async populateUsage(agentId: string, runId: string, output: AssistantMessage): Promise<void> {
		try {
			const response = await this.request<{
				totalUsage?: CursorTokenUsage;
				runs?: { id?: string; usage?: CursorTokenUsage }[];
			}>("GET", `/v1/agents/${agentId}/usage?runId=${encodeURIComponent(runId)}`);
			const usage = response.runs?.find((run) => run.id === runId)?.usage ?? response.totalUsage;
			if (!usage) return;
			output.usage.input = usage.inputTokens ?? 0;
			output.usage.output = usage.outputTokens ?? 0;
			output.usage.cacheRead = usage.cacheReadTokens ?? 0;
			output.usage.cacheWrite = usage.cacheWriteTokens ?? 0;
			output.usage.totalTokens =
				usage.totalTokens ??
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(this.model, output.usage);
		} catch {
			// Usage reporting is best-effort; never fail the turn over it.
		}
	}

	async cancelRun(agentId: string, runId: string): Promise<void> {
		await this.request("POST", `/v1/agents/${agentId}/runs/${runId}/cancel`);
	}

	private async applyPayloadHook(body: Record<string, unknown>): Promise<Record<string, unknown>> {
		const next = await this.options?.onPayload?.(body, this.model);
		return next === undefined ? body : (next as Record<string, unknown>);
	}

	private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
		const response = await this.rawRequest(method, path, body);
		return (await response.json()) as T;
	}

	private async rawRequest(
		method: string,
		path: string,
		body?: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
	): Promise<Response> {
		const baseUrl = this.model.baseUrl.replace(/\/+$/, "");
		const headers: Record<string, string> = {
			authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString("base64")}`,
			...this.model.headers,
			...this.options?.headers,
			...extraHeaders,
		};
		if (body !== undefined) {
			headers["content-type"] = "application/json";
		}
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: this.options?.signal,
		});
		await this.options?.onResponse?.(
			{ status: response.status, headers: Object.fromEntries(response.headers.entries()) },
			this.model,
		);
		if (!response.ok) {
			throw await toCursorApiError(response);
		}
		return response;
	}
}

function buildPrompt(text: string, images: ImageContent[]): Record<string, unknown> {
	const prompt: Record<string, unknown> = { text };
	const promptImages = images
		.slice(0, MAX_PROMPT_IMAGES)
		.map((image) => ({ data: image.data, mimeType: image.mimeType }));
	if (promptImages.length > 0) {
		prompt.images = promptImages;
	}
	return prompt;
}

function isTerminalRunStatus(status: string): boolean {
	return status === "FINISHED" || status === "ERROR" || status === "CANCELLED" || status === "EXPIRED";
}

function parseEventData<T>(event: CursorSseEvent): T | undefined {
	try {
		return JSON.parse(event.data) as T;
	} catch {
		return undefined;
	}
}

async function toCursorApiError(response: Response): Promise<CursorApiRequestError> {
	let code: string | undefined;
	let message = response.statusText || `HTTP ${response.status}`;
	let helpUrl: string | undefined;
	try {
		const body = (await response.json()) as { error?: { code?: unknown; message?: unknown; helpUrl?: unknown } };
		if (typeof body.error?.code === "string") code = body.error.code;
		if (typeof body.error?.message === "string") message = body.error.message;
		if (typeof body.error?.helpUrl === "string") helpUrl = body.error.helpUrl;
	} catch {
		// Non-JSON error body; keep status text.
	}
	const qualifier = code ? `${response.status}, ${code}` : `${response.status}`;
	const suffix = helpUrl ? ` (see ${helpUrl})` : "";
	return new CursorApiRequestError(
		`Cursor Cloud Agents API error (${qualifier}): ${message}${suffix}`,
		response.status,
		code,
	);
}

async function* parseSse(response: Response): AsyncGenerator<CursorSseEvent> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventType = "message";
	let dataLines: string[] = [];
	let lastId: string | undefined;

	const flush = (): CursorSseEvent | undefined => {
		if (dataLines.length === 0) {
			eventType = "message";
			lastId = undefined;
			return undefined;
		}
		const event: CursorSseEvent = { event: eventType, data: dataLines.join("\n"), id: lastId };
		eventType = "message";
		dataLines = [];
		lastId = undefined;
		return event;
	};

	const processLine = (line: string): CursorSseEvent | undefined => {
		if (line === "") return flush();
		if (line.startsWith(":")) return undefined;
		const colonIndex = line.indexOf(":");
		const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
		let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") {
			eventType = value;
		} else if (field === "data") {
			dataLines.push(value);
		} else if (field === "id") {
			lastId = value;
		}
		return undefined;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			while (true) {
				const newlineIndex = buffer.indexOf("\n");
				if (newlineIndex === -1) break;
				let line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				const event = processLine(line);
				if (event) yield event;
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0) {
			let line = buffer;
			if (line.endsWith("\r")) line = line.slice(0, -1);
			const event = processLine(line);
			if (event) yield event;
		}
		const trailing = flush();
		if (trailing) yield trailing;
	} finally {
		reader.releaseLock();
	}
}

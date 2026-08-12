// Portions of this provider are derived from Oh My Pi (OMP), MIT licensed.
// Source revision: https://github.com/can1357/oh-my-pi/commit/06aecdd51f07e689e970ceaa180abe2be0c14bbb
// Copyright (c) 2025-2026 Can Bölük. See the repository LICENSE.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http2 from "node:http2";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { getEnvApiKey } from "../../env-api-keys.js";
import { calculateCost, clampThinkingLevel } from "../../models.js";
import type {
	Api,
	AssistantMessage,
	Context,
	CursorExecHandlerContext,
	CursorExecHandlerResult,
	CursorExecHandlers,
	CursorExecPairing,
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorTodoSnapshot,
	CursorTodoSnapshotItem,
	CursorTodoSyncHandler,
	CursorToolResultHandler,
	ImageContent,
	Message,
	Model,
	ModelThinkingLevel,
	ServiceTier,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../../types.js";
import {
	type CursorExecResolvedCarrier,
	clearStreamingPartialJson,
	kCursorExecResolved,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingEnvelopeId,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../../utils/cursor-not-cloud-blocks.js";
import { AssistantMessageEventStream } from "../../utils/event-stream.js";
import { recordStreamFailure } from "../../utils/stream-failure.js";
import { buildBaseOptions } from "../simple-options.js";
import type { ConversationStep, McpToolDefinition } from "./agent_pb.js";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	type AgentRunRequest,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AgentStoreConflictErrorSchema,
	AgentStoreConflictResultSchema,
	AskQuestionInteractionResponseSchema,
	AskQuestionRejectedSchema,
	AskQuestionResultSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	CanvasDiagnosticsErrorSchema,
	CanvasDiagnosticsResultSchema,
	ClientHeartbeatSchema,
	ComputerUseErrorSchema,
	ComputerUseResultSchema,
	ConversationActionSchema,
	ConversationSearchErrorSchema,
	ConversationSearchResultSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	CreatePlanErrorSchema,
	CreatePlanRequestResponseSchema,
	CreatePlanResultSchema,
	ErrorSchema as CursorProtoErrorSchema,
	DeleteErrorSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DeleteSuccessSchema,
	DiagnosticsErrorSchema,
	DiagnosticsRejectedSchema,
	DiagnosticsResultSchema,
	DiagnosticsSuccessSchema,
	ExaFetchRequestResponse_RejectedSchema,
	ExaFetchRequestResponseSchema,
	ExaSearchRequestResponse_RejectedSchema,
	ExaSearchRequestResponseSchema,
	ExecClientControlMessageSchema,
	type ExecClientMessage,
	ExecClientMessageSchema,
	ExecClientStreamCloseSchema,
	ExecClientThrowSchema,
	type ExecServerMessage,
	ExecServerMessageSchema,
	FetchErrorSchema,
	FetchResultSchema,
	ForceBackgroundShellResultSchema,
	ForceBackgroundShellStatus,
	ForceBackgroundSubagentResultSchema,
	ForceBackgroundSubagentStatus,
	GetBlobResultSchema,
	GrepContentMatchSchema,
	GrepContentResultSchema,
	GrepCountResultSchema,
	GrepErrorSchema,
	type GrepFileCount,
	GrepFileCountSchema,
	GrepFileMatchSchema,
	GrepFilesResultSchema,
	GrepResultSchema,
	GrepSuccessSchema,
	type GrepUnionResult,
	GrepUnionResultSchema,
	type InteractionQuery,
	InteractionResponseSchema,
	KvClientMessageSchema,
	type KvServerMessage,
	ListMcpResourcesErrorSchema,
	type ListMcpResourcesExecResult,
	ListMcpResourcesExecResult_McpResourceSchema,
	ListMcpResourcesExecResultSchema,
	ListMcpResourcesSuccessSchema,
	type LsDirectoryTreeNode,
	type LsDirectoryTreeNode_File,
	LsDirectoryTreeNode_FileSchema,
	LsDirectoryTreeNodeSchema,
	LsErrorSchema,
	LsRejectedSchema,
	LsResultSchema,
	LsSuccessSchema,
	McpAllowlistPrecheckResultSchema,
	McpApprovedSchema,
	McpArgsSchema,
	McpErrorSchema,
	McpImageContentSchema,
	McpRejectedSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	McpToolDefinitionSchema,
	McpToolErrorSchema,
	McpToolNotFoundSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ModelDetailsSchema,
	ReadErrorSchema,
	ReadMcpResourceErrorSchema,
	type ReadMcpResourceExecResult,
	ReadMcpResourceExecResultSchema,
	ReadMcpResourceNotFoundSchema,
	ReadMcpResourceSuccessSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	ReadSuccessSchema,
	RecordScreenFailureSchema,
	RecordScreenResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	RequestedModelSchema,
	ResumeActionSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	SetBlobResultSchema,
	ShellAllowlistPrecheckResultSchema,
	type ShellArgs,
	ShellFailureSchema,
	ShellRejectedSchema,
	type ShellResult,
	ShellResultSchema,
	type ShellStream,
	ShellStreamExitSchema,
	ShellStreamSchema,
	ShellStreamStartSchema,
	ShellStreamStderrSchema,
	ShellStreamStdoutSchema,
	ShellSuccessSchema,
	SmartModeClassifierErrorSchema,
	SmartModeClassifierResultSchema,
	SubagentAwaitNotFoundSchema,
	SubagentAwaitResultSchema,
	SubagentErrorSchema,
	SubagentResultSchema,
	SwitchModeRequestResponse_RejectedSchema,
	SwitchModeRequestResponseSchema,
	ThinkingMessageSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WebFetchAllowlistPrecheckResultSchema,
	WebSearchRequestResponse_RejectedSchema,
	WebSearchRequestResponseSchema,
	WriteErrorSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	WriteSuccessSchema,
} from "./agent_pb.js";
import {
	$env,
	canonicalCursorGrok45ModelId,
	connectProxiedSocket,
	createRequestDebugSession,
	deterministicUuid,
	getProxyForProvider,
	isCursorGrok45RouteId,
	isRequestDebugEnabled,
	logger,
	normalizeSystemPrompts,
	parseJsonWithRepair,
	parseStreamingJson,
	parseStreamingJsonThrottled,
	type RequestDebugResponseLog,
	sanitizeText,
	shouldBypassProxy,
	toolWireSchema,
} from "./compat.js";
import { CURSOR_GROK_45_NORMAL_ROUTE_IDS, validateCursorAgentRoute } from "./discovery.js";
import * as AIError from "./errors.js";
import {
	buildMcpStateResult,
	buildNeutralHookResult,
	buildPiBashError,
	buildPiBashResult,
	buildPiEditError,
	buildPiEditRejected,
	buildPiEditResult,
	buildPiFindError,
	buildPiFindResult,
	buildPiGrepError,
	buildPiGrepResult,
	buildPiLsError,
	buildPiLsResult,
	buildPiReadError,
	buildPiReadResult,
	buildPiWriteError,
	buildPiWriteRejected,
	buildPiWriteResult,
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadDisplayPath,
	piReadPathHasRange,
	piTimeout,
} from "./exec-modern.js";

export { CURSOR_API_URL, CURSOR_CLIENT_VERSION, normalizeCursorOrigin, resolveCursorClientVersion } from "./config.js";

import { CURSOR_API_URL, normalizeCursorOrigin, resolveCursorClientVersion } from "./config.js";

const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

/**
 * Text for a recognised frame this client answers with its own typed error
 * variant. Phrased as a client capability statement, not a tool failure: the
 * model reads it and should route around the capability, not retry the call.
 */
const NOT_IMPLEMENTED_SUFFIX = "not implemented by this client";
const NOT_IMPLEMENTED = `Not implemented by this client`;

export const CURSOR_AGENT_STATE_LIMITS = {
	maxConversations: 64,
	conversationTtlMs: 30 * 60 * 1_000,
	maxBlobsPerConversation: 512,
	maxBlobBytesPerConversation: 8 * 1024 * 1024,
	maxBlobBytesTotal: 32 * 1024 * 1024,
	maxStateBytesPerConversation: 4 * 1024 * 1024,
	maxStateBytesTotal: 16 * 1024 * 1024,
	maxWarningKeys: 1_024,
	warningTtlMs: 24 * 60 * 60 * 1_000,
} as const;

type CursorAgentStateLimits = { [K in keyof typeof CURSOR_AGENT_STATE_LIMITS]: number };

type CursorConversationEntry = {
	id: string;
	conversationId: string;
	blobs: ManagedCursorBlobMap;
	blobBytes: number;
	state?: ConversationStateStructure;
	stateBytes: number;
	lastUsed: number;
	activeLeases: number;
};

export type CursorConversationStateStats = {
	conversations: number;
	activeConversations: number;
	blobBytes: number;
	stateBytes: number;
	warningKeys: number;
};

export type CursorConversationLease = {
	blobStore: Map<string, Uint8Array>;
	conversationState?: ConversationStateStructure;
	setConversationState: (state: ConversationStateStructure, now?: number) => void;
	release: (now?: number) => void;
};

export class CursorBlobCapacityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CursorBlobCapacityError";
	}
}

class ManagedCursorBlobMap extends Map<string, Uint8Array> {
	constructor(
		private readonly owner: CursorConversationStateStore,
		private readonly conversationId: string,
	) {
		super();
	}

	override set(key: string, value: Uint8Array): this {
		this.owner.setBlob(this.conversationId, key, value);
		return this;
	}

	override delete(key: string): boolean {
		return this.owner.deleteBlob(this.conversationId, key);
	}

	override clear(): void {
		this.owner.clearBlobs(this.conversationId);
	}
}

/** TTL/LRU state owner shared by the provider, injectable with tiny limits in tests. */
export class CursorConversationStateStore {
	private readonly entries = new Map<string, CursorConversationEntry>();
	private readonly warningKeys = new Map<string, number>();
	private totalBlobBytes = 0;
	private totalStateBytes = 0;
	readonly limits: CursorAgentStateLimits;

	constructor(limits: Partial<CursorAgentStateLimits> = {}) {
		this.limits = { ...CURSOR_AGENT_STATE_LIMITS, ...limits };
	}

	private touch(entry: CursorConversationEntry, now: number): void {
		entry.lastUsed = now;
		this.entries.delete(entry.id);
		this.entries.set(entry.id, entry);
	}

	private removeEntry(entry: CursorConversationEntry): void {
		this.totalBlobBytes -= entry.blobBytes;
		this.totalStateBytes -= entry.stateBytes;
		Map.prototype.clear.call(entry.blobs);
		entry.blobBytes = 0;
		entry.state = undefined;
		entry.stateBytes = 0;
		this.entries.delete(entry.id);
	}

	private evictOldestInactive(protectedId?: string): boolean {
		for (const entry of this.entries.values()) {
			if (entry.id === protectedId || entry.activeLeases > 0) continue;
			this.removeEntry(entry);
			return true;
		}
		return false;
	}

	private entry(conversationId: string, now: number, namespace = conversationId): CursorConversationEntry {
		let entry = this.entries.get(conversationId);
		if (entry) {
			this.touch(entry, now);
			return entry;
		}
		this.sweep(now);
		while (this.entries.size >= this.limits.maxConversations) {
			if (!this.evictOldestInactive()) {
				throw new CursorBlobCapacityError(
					`Cursor conversation limit (${this.limits.maxConversations}) is full with active executions`,
				);
			}
		}
		entry = {
			id: conversationId,
			conversationId: namespace,
			blobs: undefined as unknown as ManagedCursorBlobMap,
			blobBytes: 0,
			stateBytes: 0,
			lastUsed: now,
			activeLeases: 0,
		};
		entry.blobs = new ManagedCursorBlobMap(this, conversationId);
		this.entries.set(conversationId, entry);
		return entry;
	}

	acquire(conversationId: string, now = Date.now(), namespace = conversationId): CursorConversationLease {
		const entry = this.entry(conversationId, now, namespace);
		if (entry.activeLeases > 0) {
			throw new CursorBlobCapacityError(
				"Concurrent Cursor turns for the same authenticated conversation are not supported",
			);
		}
		entry.activeLeases++;
		let released = false;
		return {
			blobStore: entry.blobs,
			conversationState: entry.state,
			setConversationState: (state, at = Date.now()) => this.setConversationState(conversationId, state, at),
			release: (at = Date.now()) => {
				if (released) return;
				released = true;
				entry.activeLeases = Math.max(0, entry.activeLeases - 1);
				if (this.entries.get(conversationId) === entry) this.touch(entry, at);
			},
		};
	}

	setConversationState(conversationId: string, state: ConversationStateStructure, now = Date.now()): void {
		const entry = this.entry(conversationId, now);
		const bytes = toBinary(ConversationStateStructureSchema, state).byteLength;
		if (bytes > this.limits.maxStateBytesPerConversation) {
			throw new CursorBlobCapacityError(
				`Cursor checkpoint exceeds the per-conversation state limit (${bytes} > ${this.limits.maxStateBytesPerConversation} bytes)`,
			);
		}
		const delta = bytes - entry.stateBytes;
		while (delta > 0 && this.totalStateBytes + delta > this.limits.maxStateBytesTotal) {
			if (!this.evictOldestInactive(conversationId)) {
				throw new CursorBlobCapacityError("Cursor checkpoint state byte limit is full with active conversations");
			}
		}
		this.totalStateBytes += delta;
		entry.state = state;
		entry.stateBytes = bytes;
		this.touch(entry, now);
	}

	setBlob(conversationId: string, key: string, value: Uint8Array, now = Date.now()): void {
		const entry = this.entry(conversationId, now);
		const previous = Map.prototype.get.call(entry.blobs, key) as Uint8Array | undefined;
		const delta = value.byteLength - (previous?.byteLength ?? 0);
		const nextCount = entry.blobs.size + (previous ? 0 : 1);
		if (nextCount > this.limits.maxBlobsPerConversation) {
			throw new CursorBlobCapacityError(
				`Cursor blob count limit exceeded (${nextCount} > ${this.limits.maxBlobsPerConversation})`,
			);
		}
		if (entry.blobBytes + delta > this.limits.maxBlobBytesPerConversation) {
			throw new CursorBlobCapacityError(
				`Cursor blob byte limit exceeded (${entry.blobBytes + delta} > ${this.limits.maxBlobBytesPerConversation})`,
			);
		}
		while (delta > 0 && this.totalBlobBytes + delta > this.limits.maxBlobBytesTotal) {
			if (!this.evictOldestInactive(conversationId)) {
				throw new CursorBlobCapacityError("Cursor global blob byte limit is full with active conversations");
			}
		}
		Map.prototype.set.call(entry.blobs, key, value);
		entry.blobBytes += delta;
		this.totalBlobBytes += delta;
		this.touch(entry, now);
	}

	deleteBlob(conversationId: string, key: string, now = Date.now()): boolean {
		const entry = this.entries.get(conversationId);
		if (!entry) return false;
		const previous = Map.prototype.get.call(entry.blobs, key) as Uint8Array | undefined;
		if (!previous || !Map.prototype.delete.call(entry.blobs, key)) return false;
		entry.blobBytes -= previous.byteLength;
		this.totalBlobBytes -= previous.byteLength;
		this.touch(entry, now);
		return true;
	}

	clearBlobs(conversationId: string, now = Date.now()): void {
		const entry = this.entries.get(conversationId);
		if (!entry) return;
		this.totalBlobBytes -= entry.blobBytes;
		entry.blobBytes = 0;
		Map.prototype.clear.call(entry.blobs);
		this.touch(entry, now);
	}

	hasWarning(key: string, now = Date.now()): boolean {
		this.cleanupWarnings(now);
		if (!this.warningKeys.has(key)) return false;
		this.warningKeys.delete(key);
		this.warningKeys.set(key, now);
		return true;
	}

	markWarning(key: string, now = Date.now()): void {
		this.cleanupWarnings(now);
		this.warningKeys.delete(key);
		this.warningKeys.set(key, now);
		while (this.warningKeys.size > this.limits.maxWarningKeys) {
			const oldest = this.warningKeys.keys().next().value;
			if (oldest === undefined) break;
			this.warningKeys.delete(oldest);
		}
	}

	private cleanupWarnings(now: number): void {
		for (const [key, lastUsed] of this.warningKeys) {
			if (now - lastUsed <= this.limits.warningTtlMs) break;
			this.warningKeys.delete(key);
		}
	}

	sweep(now = Date.now()): number {
		let removed = 0;
		for (const entry of [...this.entries.values()]) {
			if (entry.activeLeases > 0 || now - entry.lastUsed <= this.limits.conversationTtlMs) continue;
			this.removeEntry(entry);
			removed++;
		}
		while (this.entries.size > this.limits.maxConversations && this.evictOldestInactive()) removed++;
		this.cleanupWarnings(now);
		return removed;
	}

	disposeConversation(conversationId: string): boolean {
		const entry = this.entries.get(conversationId);
		if (!entry || entry.activeLeases > 0) return false;
		this.removeEntry(entry);
		return true;
	}

	disposeConversationNamespace(conversationId: string): boolean {
		let disposed = false;
		for (const entry of [...this.entries.values()]) {
			if (entry.conversationId === conversationId && entry.activeLeases === 0) {
				this.removeEntry(entry);
				disposed = true;
			}
		}
		return disposed;
	}

	clear(): void {
		for (const entry of [...this.entries.values()]) this.removeEntry(entry);
		this.warningKeys.clear();
	}

	stats(): CursorConversationStateStats {
		return {
			conversations: this.entries.size,
			activeConversations: [...this.entries.values()].filter((entry) => entry.activeLeases > 0).length,
			blobBytes: this.totalBlobBytes,
			stateBytes: this.totalStateBytes,
			warningKeys: this.warningKeys.size,
		};
	}
}

const cursorConversationStateStore = new CursorConversationStateStore();

export function sweepCursorAgentState(now = Date.now()): number {
	return cursorConversationStateStore.sweep(now);
}

export function disposeCursorAgentConversation(conversationId: string): boolean {
	return cursorConversationStateStore.disposeConversationNamespace(conversationId);
}

export function getCursorAgentStateStats(): CursorConversationStateStats {
	return cursorConversationStateStore.stats();
}

export interface CursorAgentOptions extends StreamOptions {
	customSystemPrompt?: string;
	/** Prime reasoning request; always clamped to Cursor's low/medium/high product levels. */
	reasoning?: ModelThinkingLevel;
	conversationId?: string;
	/** Header-safe schema/client override. Defaults to the bundled tested client pin. */
	clientVersion?: string;
	/** Test-only capability fixture; production requests discover routes from AgentService. */
	discoveredModelIds?: ReadonlySet<string>;
	execHandlers?: CursorExecHandlers;
	onToolResult?: CursorToolResultHandler;
}

const CONNECT_END_STREAM_FLAG = 0b00000010;
const CONNECT_COMPRESSED_FLAG = 0b00000001;
const MAX_CONNECT_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_CONNECT_PENDING_BYTES = 64 * 1024 * 1024;

interface CursorLogEntry {
	ts: number;
	type: string;
	subtype?: string;
	data?: unknown;
}

async function appendCursorDebugLog(entry: CursorLogEntry): Promise<void> {
	const logPath = $env.DEBUG_CURSOR_LOG;
	if (!logPath) return;
	try {
		await fs.appendFile(logPath, `${JSON.stringify(entry, debugReplacer)}\n`);
	} catch {
		// Ignore debug log failures
	}
}

function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	const normalizedData = data ? decodeLogData(data) : data;
	const entry: CursorLogEntry = { ts: Date.now(), type, subtype, data: normalizedData };
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && normalizedData ? ` ${JSON.stringify(normalizedData, debugReplacer)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
	void appendCursorDebugLog(entry);
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	if (data.byteLength > MAX_CONNECT_FRAME_BYTES) {
		throw new AIError.ProviderResponseError("Cursor outbound Connect frame exceeded 32 MiB", {
			provider: "cursor-not-cloud",
			kind: "oversized",
		});
	}
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function writeConnectMessage(stream: http2.ClientHttp2Stream, data: Uint8Array, flags = 0): void {
	if (stream.closed || stream.destroyed) {
		throw new AIError.ProviderResponseError("Cursor stream is closed before a required client reply", {
			provider: "cursor-not-cloud",
			kind: "transport",
		});
	}
	const frame = frameConnectMessage(data, flags);
	if (stream.writableLength + frame.byteLength > MAX_CONNECT_PENDING_BYTES) {
		throw new AIError.ProviderResponseError("Cursor stream backpressure exceeded the bounded write buffer", {
			provider: "cursor-not-cloud",
			kind: "backpressure",
		});
	}
	const accepted = stream.write(frame);
	if (!accepted && stream.writableLength > MAX_CONNECT_PENDING_BYTES) {
		throw new AIError.ProviderResponseError("Cursor stream backpressure exceeded the bounded write buffer", {
			provider: "cursor-not-cloud",
			kind: "backpressure",
		});
	}
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(data));
	} catch {
		return new AIError.ProviderResponseError("Failed to parse Connect end stream", { kind: "envelope" });
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return new AIError.ProviderResponseError("Connect end stream had an invalid shape", { kind: "envelope" });
	}
	const error = (payload as { error?: unknown }).error;
	if (error === undefined) return null;
	if (!error || typeof error !== "object" || Array.isArray(error)) {
		return new AIError.ProviderResponseError("Connect end error had an invalid shape", { kind: "envelope" });
	}
	const record = error as { code?: unknown; message?: unknown };
	const code = typeof record.code === "string" ? record.code : "unknown";
	const message = typeof record.message === "string" ? record.message : "Unknown error";
	return new AIError.ProviderResponseError(`Connect error ${code}: ${message}`, { kind: "envelope" });
}

function safeDecodeGrpcMessage(value: unknown): string {
	const raw = String(value ?? "");
	try {
		return sanitizeText(decodeURIComponent(raw)).slice(0, 512);
	} catch {
		return sanitizeText(raw).slice(0, 512);
	}
}

/**
 * Maps an opaque HTTP/2 negotiation failure into an actionable error.
 *
 * bun only opens an HTTP/2 session when TLS-ALPN negotiates `h2`. Behind a
 * TLS-intercepting proxy that strips ALPN (e.g. Zscaler), the handshake yields
 * no `h2` protocol and bun throws `ERR_HTTP2_ERROR: h2 is not supported`. The
 * Cursor run RPC is HTTP/2-only (the ALB rejects HTTP/1.1 with 464), so there
 * is no h1 fallback the way model discovery has one — the run simply cannot
 * proceed. Replace the opaque message with one that names the cause and points
 * at the `providers.cursor-not-cloud.baseUrl` workaround.
 *
 * Non-ALPN errors pass through untouched.
 */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
		return new AIError.ProviderResponseError(
			`Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
				"This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate " +
				"h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy (e.g. Zscaler). " +
				"Front the provider with a local HTTP/2 bridge and set providers.cursor-not-cloud.baseUrl to it.",
			{ provider: "cursor-not-cloud", kind: "runtime", cause: error },
		);
	}
	return error;
}

function debugBytes(bytes: Uint8Array, asHex: boolean): string {
	if (asHex) {
		return Buffer.from(bytes).toString("hex");
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (/^[\x20-\x7E\s]*$/.test(text)) return text;
	} catch {
		// Debug rendering deliberately falls back to a bounded hexadecimal representation.
	}
	return Buffer.from(bytes).toString("hex");
}

function debugReplacer(key: string, value: unknown): unknown {
	if (
		value instanceof Uint8Array ||
		(value && typeof value === "object" && "type" in value && value.type === "Buffer")
	) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as any).data);
		const asHex = key === "blobId" || key === "blob_id" || key.endsWith("Id") || key.endsWith("_id");
		return debugBytes(bytes, asHex);
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}

function extractLogBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value && typeof value === "object" && "type" in value && value.type === "Buffer") {
		const data = (value as { data?: number[] }).data;
		if (Array.isArray(data)) {
			return new Uint8Array(data);
		}
	}
	return null;
}

function decodeMcpArgsForLog(args?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	let mutated = false;
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const bytes = extractLogBytes(value);
		if (bytes) {
			decoded[key] = decodeMcpArgValue(bytes);
			mutated = true;
			continue;
		}
		const normalizedValue = decodeLogData(value);
		decoded[key] = normalizedValue;
		if (normalizedValue !== value) {
			mutated = true;
		}
	}
	return mutated ? decoded : args;
}

function decodeLogData(value: unknown): unknown {
	if (!value || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => decodeLogData(entry));
	}
	const record = value as Record<string, unknown>;
	const typeName = record.$typeName;
	const stripTypeName = typeof typeName === "string" && typeName.startsWith("agent.v1.");

	if (typeName === "agent.v1.McpArgs") {
		const decodedArgs = decodeMcpArgsForLog(record.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		return decodedArgs ? { ...base, args: decodedArgs } : base;
	}
	if (typeName === "agent.v1.McpToolCall") {
		const argsRecord = record.args as Record<string, unknown> | undefined;
		const decodedArgs = decodeMcpArgsForLog(argsRecord?.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		if (decodedArgs && argsRecord) {
			return { ...base, args: { ...argsRecord, args: decodedArgs } };
		}
		return base;
	}

	let mutated = stripTypeName;
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (stripTypeName && key === "$typeName") {
			continue;
		}
		const normalizedEntry = decodeLogData(entry);
		decoded[key] = normalizedEntry;
		if (normalizedEntry !== entry) {
			mutated = true;
		}
	}
	return mutated ? decoded : record;
}

function omitTypeName(record: Record<string, unknown>): Record<string, unknown> {
	const { $typeName: _, ...rest } = record;
	return rest;
}

/** Non-secret state namespace: credential fingerprint + normalized endpoint + conversation id. */
export function createCursorConversationStateKey(apiKey: string, baseUrl: string, conversationId: string): string {
	const authFingerprint = createHash("sha256").update(apiKey).digest("hex");
	const origin = normalizeCursorOrigin(baseUrl);
	const hash = createHash("sha256");
	for (const value of [authFingerprint, origin, conversationId]) {
		const bytes = Buffer.from(value, "utf8");
		const length = Buffer.allocUnsafe(4);
		length.writeUInt32BE(bytes.length);
		hash.update(length).update(bytes);
	}
	return hash.digest("hex");
}

export type CursorOptions = CursorAgentOptions;

export const streamCursor: StreamFunction<"cursor-not-cloud", CursorAgentOptions> = (
	model: Model<"cursor-not-cloud">,
	context: Context,
	options?: CursorOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const turnAbortController = new AbortController();
		const turnSignal = options?.signal
			? AbortSignal.any([options.signal, turnAbortController.signal])
			: turnAbortController.signal;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-not-cloud" as Api,
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
		let wireModelId = model.id;

		// Declared outside the `try` because BOTH exits must drain it: an exec
		// handler decoded from the last chunk can still be running when the
		// transport fails, and the error path finalizes the synthesized call just
		// like the success path does.
		const inFlightDispatches = new Set<Promise<void>>();
		const execAbortControllers = new Map<number, AbortController>();
		// A dispatch can spawn another (a handler that decodes a nested frame), so
		// re-check rather than awaiting one snapshot. Each dispatch already
		// swallows its own rejection, so this only waits.
		//
		// The wait is bounded by the abort signal: exec handlers have no
		// cancellation contract (the coding-agent bridge invokes `tool.execute`
		// with no signal), so a hung or long-running tool would otherwise hold
		// the terminal event hostage after the user already gave up on the turn.
		// Once aborted, the Agent finalizes from the abort error and discards
		// late results regardless, so skipping the rest of the drain loses
		// nothing that could still be delivered.
		const drainInFlightDispatches = async (): Promise<void> => {
			while (inFlightDispatches.size > 0) {
				// Only a caller cancellation may skip the drain. Internal turn
				// cancellation tells cooperative handlers to stop, but handlers that
				// already performed side effects still need their result paired before
				// the terminal error is emitted.
				if (options?.signal?.aborted) return;
				if (!options?.signal) {
					await Promise.all([...inFlightDispatches]);
					continue;
				}
				let onAbort: (() => void) | undefined;
				const aborted = new Promise<void>((resolve) => {
					onAbort = resolve;
					options.signal!.addEventListener("abort", onAbort, { once: true });
				});
				try {
					await Promise.race([Promise.all([...inFlightDispatches]), aborted]);
				} finally {
					if (onAbort) options.signal.removeEventListener("abort", onAbort);
				}
			}
		};

		let conversationLease: CursorConversationLease | undefined;
		let h2Client: http2.ClientHttp2Session | null = null;
		let h2Request: http2.ClientHttp2Stream | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let overallTimer: NodeJS.Timeout | null = null;
		let idleTimer: NodeJS.Timeout | null = null;
		let connectTimer: NodeJS.Timeout | null = null;
		let debugResponseLogPromise: Promise<RequestDebugResponseLog | undefined> | undefined;
		let resolveH2!: () => void;
		let rejectH2!: (error: unknown) => void;
		const h2Completion = {
			promise: new Promise<void>((resolve, reject) => {
				resolveH2 = resolve;
				rejectH2 = reject;
			}),
			resolve: resolveH2,
			reject: rejectH2,
		};
		// A synchronous failure while constructing/writing the first frame can
		// leave transport callbacks rejecting before control reaches the await.
		// Keep that rejection observed; the normal await still preserves it.
		void h2Completion.promise.catch(() => {});
		let h2Settled = false;
		let headersAccepted = false;
		let sawTurnEnded = false;
		let sawEndEnvelope = false;
		const execDispatchRegistry = new Map<number, CursorExecDispatchRecord>();
		const toolResultSinkRegistry = new Map<string, Promise<ToolResultMessage>>();
		let dispatchError: unknown;
		let forcedTerminalError: unknown;
		let endStreamError: Error | null = null;
		// Reachable from the catch: a stream that dies mid-turn must still close
		// and pair the blocks it left open, and `state` itself is scoped to the
		// try below.
		let openBlockState: BlockState | undefined;
		const overallTimeoutMs = options?.timeoutMs ?? 300_000;
		const settleH2 = (error?: unknown): void => {
			if (h2Settled) return;
			const rejectTerminal = (failure: unknown) => {
				h2Settled = true;
				turnAbortController.abort(failure);
				h2Completion.reject(failure);
			};
			if (error !== undefined) {
				rejectTerminal(error);
				return;
			}
			if (endStreamError) {
				rejectTerminal(endStreamError);
				return;
			}
			if (!sawTurnEnded) {
				rejectTerminal(
					new AIError.ProviderResponseError("Cursor stream ended before turnEnded", {
						provider: "cursor-not-cloud",
						kind: "incomplete-stream",
					}),
				);
				return;
			}
			if (!sawEndEnvelope) {
				rejectTerminal(
					new AIError.ProviderResponseError("Cursor stream ended before the Connect end envelope", {
						provider: "cursor-not-cloud",
						kind: "incomplete-stream",
					}),
				);
				return;
			}
			h2Settled = true;
			h2Completion.resolve();
		};
		const failTimedOut = (kind: "connect" | "idle" | "overall") => {
			const error = new AIError.ProviderResponseError(`Cursor ${kind} timeout after ${overallTimeoutMs}ms`, {
				provider: "cursor-not-cloud",
				kind: "timeout",
			});
			forcedTerminalError ??= error;
			turnAbortController.abort(error);
			settleH2(error);
			h2Request?.close();
		};
		overallTimer = setTimeout(() => failTimedOut("overall"), overallTimeoutMs);
		const onCallerAbort = () => {
			const error = new AIError.AbortError();
			turnAbortController.abort(error);
			settleH2(error);
			h2Request?.close();
		};
		if (options?.signal?.aborted) onCallerAbort();
		else options?.signal?.addEventListener("abort", onCallerAbort, { once: true });

		try {
			wireModelId = resolveCursorAgentModelId(model, options);
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(undefined, "Cursor API key (access token) is required");
			}
			if (options?.signal?.aborted) {
				throw new AIError.AbortError();
			}
			await raceCursorExecWithAbort(
				validateCursorAgentRoute(apiKey, wireModelId, {
					baseUrl: model.baseUrl,
					clientVersion: options?.clientVersion,
					timeoutMs: options?.timeoutMs,
					signal: turnSignal,
					modelIds: options?.discoveredModelIds,
				}),
				turnSignal,
			);

			const conversationId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
			const baseUrl = normalizeCursorOrigin(model.baseUrl || CURSOR_API_URL);
			const stateKey = createCursorConversationStateKey(apiKey, baseUrl, conversationId);
			conversationLease = cursorConversationStateStore.acquire(stateKey, Date.now(), conversationId);
			const blobStore = conversationLease.blobStore;
			const { requestBytes, conversationState } = await raceCursorExecWithAbort(
				buildGrpcRequest(model, context, options, {
					conversationId,
					blobStore,
					conversationState: conversationLease.conversationState,
					signal: turnSignal,
				}),
				turnSignal,
			);
			conversationLease.setConversationState(conversationState);
			const requestContextTools = buildMcpToolDefinitions(context.tools);

			const requestPath = "/agent.v1.AgentService/Run";
			const requestHeaders = {
				":method": "POST",
				":path": requestPath,
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				te: "trailers",
				authorization: `Bearer ${apiKey}`,
				"x-ghost-mode": "true",
				"x-cursor-client-version": resolveCursorClientVersion(options?.clientVersion),
				"x-cursor-client-type": "cli",
				"x-request-id": crypto.randomUUID(),
			};
			const debugSession = isRequestDebugEnabled()
				? await raceCursorExecWithAbort(
						createRequestDebugSession({
							protocol: "http2",
							method: "POST",
							url: new URL(requestPath, baseUrl).toString(),
							headers: requestHeaders,
							bodyBase64: Buffer.from(requestBytes).toString("base64"),
						}),
						turnSignal,
					)
				: undefined;

			const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(model.provider);
			if (proxyUrl) {
				const tlsSocket = await raceCursorExecWithAbort(
					connectProxiedSocket(proxyUrl, baseUrl, {
						signal: turnSignal,
						timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
					}),
					turnSignal,
				);
				h2Client = http2.connect(baseUrl, {
					createConnection: () => tlsSocket,
				});
			} else {
				h2Client = http2.connect(baseUrl);
			}
			h2Client.on("error", (error) => settleH2(mapH2TransportError(error, baseUrl)));

			connectTimer = setTimeout(() => failTimedOut("connect"), Math.min(overallTimeoutMs, 30_000));
			h2Client.once("connect", () => {
				if (connectTimer) clearTimeout(connectTimer);
				connectTimer = null;
			});
			const resetIdleTimer = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => failTimedOut("idle"), overallTimeoutMs);
			};
			resetIdleTimer();
			h2Request = h2Client.request(requestHeaders);

			stream.push({ type: "start", partial: output });

			let pendingBuffer: Buffer = Buffer.alloc(0);
			let currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentToolCall: ToolCallState | null = null;
			const resolvedMcpToolCallIds = new Set<string>();
			const usageState: UsageState = { sawTokenDelta: false };
			const trackedOnToolResult: CursorToolResultHandler | undefined = options?.onToolResult
				? (toolResult) => {
						const key = `${toolResult.toolCallId}\0${toolResult.toolName}`;
						const existing = toolResultSinkRegistry.get(key);
						if (existing) return existing;
						if (toolResultSinkRegistry.size >= 4_096) {
							const error = new AIError.ProviderResponseError(
								"Cursor tool-result sink registry exceeded its per-turn bound",
								{ provider: "cursor-not-cloud", kind: "oversized" },
							);
							dispatchError ??= error;
							settleH2(error);
							return Promise.resolve(toolResult);
						}
						const work = raceCursorExecWithAbort(
							Promise.resolve()
								.then(() => options.onToolResult?.(toolResult))
								.then((updated) => updated ?? toolResult),
							turnSignal,
						);
						toolResultSinkRegistry.set(key, work);
						const monitored = work.then(
							() => undefined,
							(error) => {
								dispatchError ??= error;
								settleH2(error);
								h2Request?.close();
							},
						);
						inFlightDispatches.add(monitored);
						void monitored.then(() => inFlightDispatches.delete(monitored));
						return work;
					}
				: undefined;

			const state: BlockState = {
				get currentTextBlock() {
					return currentTextBlock;
				},
				get currentThinkingBlock() {
					return currentThinkingBlock;
				},
				get currentToolCall() {
					return currentToolCall;
				},
				openToolCalls: new Map<string, ToolCallState>(),
				resolvedMcpToolCallIds,
				get firstTokenTime() {
					return firstTokenTime;
				},
				setTextBlock: (b) => {
					currentTextBlock = b;
				},
				setThinkingBlock: (b) => {
					currentThinkingBlock = b;
				},
				setToolCall: (t) => {
					currentToolCall = t;
				},
				setFirstTokenTime: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
				onTodoSnapshot: options?.execHandlers?.todoSync?.bind(options.execHandlers),
				onToolResult: trackedOnToolResult,
			};
			openBlockState = state;

			const onConversationCheckpoint = (checkpoint: ConversationStateStructure) => {
				conversationLease?.setConversationState(checkpoint);
			};

			h2Request.on("response", (headers) => {
				debugResponseLogPromise = debugSession?.openResponseLog(
					`HTTP/2 ${headers[":status"] ?? ""}`.trim(),
					headers,
				);
				const status = Number(headers[":status"] ?? 0);
				const contentType = String(headers["content-type"] ?? "")
					.split(";", 1)[0]
					?.trim()
					.toLowerCase();
				if (status < 200 || status >= 300) {
					const error = new AIError.ProviderResponseError(`Cursor run failed with HTTP ${status}`, {
						provider: "cursor-not-cloud",
						kind: status === 401 || status === 403 ? "auth" : "http",
						status,
					});
					settleH2(error);
					h2Request?.close();
					return;
				}
				if (contentType !== "application/connect+proto") {
					const error = new AIError.ProviderResponseError(
						`Cursor run returned unsupported content type ${contentType || "<missing>"}`,
						{ provider: "cursor-not-cloud", kind: "content-type", status },
					);
					settleH2(error);
					h2Request?.close();
					return;
				}
				headersAccepted = true;
			});

			h2Request.on("data", (chunk: Buffer) => {
				if (!headersAccepted || h2Settled) return;
				if (debugResponseLogPromise) {
					void debugResponseLogPromise.then((log) => {
						log?.write(chunk);
					});
				}
				resetIdleTimer();
				// Steady state drains fully per chunk; cap both individual frames and aggregate pending data.
				pendingBuffer = pendingBuffer.length === 0 ? chunk : Buffer.concat([pendingBuffer, chunk]);
				if (pendingBuffer.length > MAX_CONNECT_PENDING_BYTES) {
					const error = new AIError.ProviderResponseError("Cursor pending Connect data exceeded 64 MiB", {
						provider: "cursor-not-cloud",
						kind: "oversized",
					});
					settleH2(error);
					h2Request?.close();
					return;
				}

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (msgLen > MAX_CONNECT_FRAME_BYTES) {
						const error = new AIError.ProviderResponseError("Cursor Connect frame exceeded 32 MiB", {
							provider: "cursor-not-cloud",
							kind: "oversized",
						});
						settleH2(error);
						h2Request?.close();
						return;
					}
					if (
						(flags & CONNECT_COMPRESSED_FLAG) !== 0 ||
						(flags & ~(CONNECT_COMPRESSED_FLAG | CONNECT_END_STREAM_FLAG)) !== 0
					) {
						const error = new AIError.ProviderResponseError(
							"Cursor used unsupported Connect compression or flags",
							{
								provider: "cursor-not-cloud",
								kind: "flags",
							},
						);
						settleH2(error);
						h2Request?.close();
						return;
					}
					if (pendingBuffer.length < 5 + msgLen) break;

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags === CONNECT_END_STREAM_FLAG) {
						if (sawEndEnvelope) {
							settleH2(
								new AIError.ProviderResponseError("Cursor sent duplicate Connect end envelopes", {
									provider: "cursor-not-cloud",
									kind: "envelope",
								}),
							);
							h2Request?.close();
							return;
						}
						sawEndEnvelope = true;
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							endStreamError = endError;
							settleH2(endError);
							h2Request?.close();
							return;
						}
						if (!sawTurnEnded) {
							settleH2(
								new AIError.ProviderResponseError("Cursor Connect end envelope arrived before turnEnded", {
									provider: "cursor-not-cloud",
									kind: "envelope",
								}),
							);
							h2Request?.close();
							return;
						}
						continue;
					}
					if (sawEndEnvelope) {
						const error = new AIError.ProviderResponseError("Cursor sent data after its Connect end envelope", {
							provider: "cursor-not-cloud",
							kind: "envelope",
						});
						settleH2(error);
						h2Request?.close();
						return;
					}
					if (sawTurnEnded) {
						const error = new AIError.ProviderResponseError("Cursor sent data after turnEnded", {
							provider: "cursor-not-cloud",
							kind: "envelope",
						});
						settleH2(error);
						h2Request?.close();
						return;
					}

					try {
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
						const isTurnEnded =
							serverMessage.message.case === "interactionUpdate" &&
							serverMessage.message.value.message?.case === "turnEnded";
						// Dispatch is fire-and-forget so the socket keeps draining while a
						// handler runs, but the promise is tracked: `done` must not be
						// pushed while an exec handler is still resolving, or the Agent
						// drains its Cursor result buffer before the handler reserved its
						// entry and the call is left unpaired. Awaited after
						// `h2Completion` below.
						const dispatch = handleServerMessage(
							serverMessage,
							output,
							stream,
							state,
							blobStore,
							h2Request!,
							options?.execHandlers,
							trackedOnToolResult,
							usageState,
							requestContextTools,
							onConversationCheckpoint,
							execAbortControllers,
							turnSignal,
							execDispatchRegistry,
						).catch((error) => {
							dispatchError ??= error;
							log("error", "handleServerMessage", { error: String(error) });
							settleH2(error);
							h2Request?.close();
						});
						inFlightDispatches.add(dispatch);
						void dispatch.finally(() => inFlightDispatches.delete(dispatch));

						// Application completion is not protocol success; wait for a clean HTTP/2 end.
						if (isTurnEnded) {
							sawTurnEnded = true;
						}
					} catch (error) {
						log("error", "parseServerMessage", { error: String(error) });
						settleH2(
							new AIError.ProviderResponseError("Cursor server protobuf could not be decoded", {
								provider: "cursor-not-cloud",
								kind: "decode",
								cause: error,
							}),
						);
						h2Request?.close();
						return;
					}
				}
			});

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed) {
					return;
				}
				const heartbeatMessage = create(AgentClientMessageSchema, {
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				});
				const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeatMessage);
				try {
					writeConnectMessage(h2Request, heartbeatBytes);
				} catch (error) {
					settleH2(error);
					h2Request?.close();
				}
			};

			const closeDebugLog = async (): Promise<void> => {
				const log = await debugResponseLogPromise;
				await log?.close();
			};

			h2Request.on("trailers", (trailers) => {
				try {
					const status = trailers["grpc-status"];
					if (status && status !== "0" && !endStreamError) {
						endStreamError = new AIError.ProviderResponseError(
							`gRPC error ${status}: ${safeDecodeGrpcMessage(trailers["grpc-message"])}`,
							{ provider: "cursor-not-cloud", kind: "envelope" },
						);
						settleH2(endStreamError);
						h2Request?.close();
					}
				} catch (error) {
					settleH2(error);
					h2Request?.close();
				}
			});

			h2Request.on("end", () => {
				void closeDebugLog()
					.then(() => {
						if (pendingBuffer.length !== 0) {
							settleH2(
								new AIError.ProviderResponseError("Cursor stream ended with a partial Connect frame", {
									provider: "cursor-not-cloud",
									kind: "truncated",
								}),
							);
							return;
						}
						settleH2();
					})
					.catch((error) => settleH2(error));
			});

			h2Request.on("error", (error) => {
				const mapped = mapH2TransportError(error, baseUrl);
				void closeDebugLog().finally(() => settleH2(mapped));
			});
			h2Request.on("aborted", () => {
				settleH2(
					new AIError.ProviderResponseError("Cursor HTTP/2 stream was aborted", {
						provider: "cursor-not-cloud",
						kind: "transport",
					}),
				);
			});
			h2Request.on("close", () => {
				if (!h2Settled && !h2Request?.readableEnded) {
					settleH2(
						new AIError.ProviderResponseError("Cursor HTTP/2 stream closed abnormally", {
							provider: "cursor-not-cloud",
							kind: "transport",
						}),
					);
				}
			});

			writeConnectMessage(h2Request, requestBytes);
			heartbeatTimer = setInterval(sendHeartbeat, 5000);
			await h2Completion.promise;
			// The transport is done, but a handler decoded from the last chunk may
			// still be running: exec handlers and `onToolResult` transformers are
			// async. Pushing `done` now would let the Agent drain its Cursor result
			// buffer before such a handler reserves its entry, leaving the call
			// unpaired and stripped from every rebuilt transcript. Each dispatch
			// already swallows its own rejection, so this only waits.
			await drainInFlightDispatches();
			if (forcedTerminalError) throw forcedTerminalError;
			if (dispatchError) throw dispatchError;

			endCurrentTextBlock(output, stream, state);
			endCurrentThinkingBlock(output, stream, state);
			flushOpenToolCalls(output, stream, state);
			await drainInFlightDispatches();
			if (forcedTerminalError) throw forcedTerminalError;
			if (dispatchError) throw dispatchError;

			calculateCursorAgentUsageCost(model, wireModelId, output.usage);

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			const terminalError = forcedTerminalError ?? error;
			// Same reason as the success path: the Agent finalizes the synthesized
			// call from this terminal error and clears its Cursor result buffer, so
			// a handler still running would land its real result after `agent_end`
			// and be discarded — even though the tool may already have run side
			// effects. Wait for it first; on abort the drain returns immediately
			// (handlers have no cancellation contract and must not delay the
			// terminal error the user asked for).
			await drainInFlightDispatches();
			// A stream that dies mid-turn leaves blocks open, and this is the path
			// it takes: `settleH2` rejects when the transport closes without
			// `turnEnded`, so the success-path flush above never runs. Closing
			// them here settles their live cards and pairs the server-owned calls
			// (`connect_scm`, native todo) that nothing else answers — an
			// unpaired call is stripped from every rebuilt transcript.
			// Undefined only when the failure predates the state's construction,
			// in which case no block was ever opened.
			if (openBlockState) {
				endCurrentTextBlock(output, stream, openBlockState);
				endCurrentThinkingBlock(output, stream, openBlockState);
				flushOpenToolCalls(output, stream, openBlockState);
			}
			const result = await AIError.finalize(terminalError, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			recordStreamFailure(model, output, terminalError);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			const log = await debugResponseLogPromise;
			await log?.close();
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			if (overallTimer) clearTimeout(overallTimer);
			if (idleTimer) clearTimeout(idleTimer);
			if (connectTimer) clearTimeout(connectTimer);
			options?.signal?.removeEventListener("abort", onCallerAbort);
			turnAbortController.abort();
			for (const controller of execAbortControllers.values()) controller.abort();
			execAbortControllers.clear();
			execDispatchRegistry.clear();
			toolResultSinkRegistry.clear();
			conversationLease?.release();
			conversationLease = undefined;
			h2Request?.close();
			h2Client?.close();
		}
	})();

	return stream;
};

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "todo" | "cursor-exec" | "connect-scm";
	[kStreamingEnvelopeId]?: string;
	[kCursorExecResolved]?: true;
};

export interface BlockState {
	currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null;
	currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null;
	currentToolCall: ToolCallState | null;
	/**
	 * Open streamed tool-call blocks, keyed by the interaction envelope's
	 * `call_id`.
	 *
	 * Cursor interleaves calls: two `toolCallStarted` frames can arrive before
	 * either completes. A single "current" slot would let the second overwrite
	 * the first, orphaning a block that nothing then settles. Every keyed block
	 * stays reachable until its own completion, and `currentToolCall` remains
	 * only as the fallback for frames that carry no `call_id`.
	 */
	openToolCalls: Map<string, ToolCallState>;
	/** MCP call IDs synthesized from exec frames before their redundant streamed block arrives. */
	resolvedMcpToolCallIds: Set<string>;
	firstTokenTime: number | undefined;
	setTextBlock: (b: (TextContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setThinkingBlock: (b: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setToolCall: (t: ToolCallState | null) => void;
	setFirstTokenTime: () => void;
	/** Mirror a server-confirmed todo snapshot into local session state. */
	onTodoSnapshot?: CursorTodoSyncHandler;
	/**
	 * Persist a paired `toolResult` for a server-resolved call. Native todo calls
	 * never travel the exec channel, so without this the resolved block has no
	 * matching result and every transcript rebuild strips it as dangling.
	 */
	onToolResult?: CursorToolResultHandler;
}

function markCursorExecResolved(block: CursorExecResolvedCarrier): void {
	block[kCursorExecResolved] = true;
}

export interface UsageState {
	sawTokenDelta: boolean;
	sawTerminalUsage?: boolean;
}

/** One bounded correlation record per exec id, retained until the turn reaches terminal. */
export interface CursorExecDispatchRecord {
	requestFingerprint: string;
	completion: Promise<void>;
}

/** Exported for tests: drives one Cursor server message through the stream (exec waits mark the stream busy). */
export async function handleServerMessage(
	msg: AgentServerMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	usageState: UsageState,
	requestContextTools: McpToolDefinition[],
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
	execAbortControllers = new Map<number, AbortController>(),
	providerSignal?: AbortSignal,
	execDispatchRegistry = new Map<number, CursorExecDispatchRecord>(),
): Promise<void> {
	const msgCase = msg.message.case;

	log("serverMessage", msgCase, msg.message.value);

	if (msgCase === "interactionUpdate") {
		processInteractionUpdate(msg.message.value, output, stream, state, usageState);
	} else if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request);
	} else if (msgCase === "execServerMessage") {
		const execMessage = msg.message.value as ExecServerMessage;
		const requestFingerprint = createHash("sha256")
			.update(toBinary(ExecServerMessageSchema, execMessage))
			.digest("hex");
		const existing = execDispatchRegistry.get(execMessage.id);
		if (existing) {
			const disposition = existing.requestFingerprint === requestFingerprint ? "same payload" : "different payload";
			throw new AIError.ProviderResponseError(`Cursor sent a duplicate exec id with ${disposition}`, {
				provider: "cursor-not-cloud",
				kind: "duplicate-exec",
				execId: execMessage.id,
			});
		}
		if (execDispatchRegistry.size >= 4_096) {
			throw new AIError.ProviderResponseError("Cursor exec correlation registry exceeded its per-turn bound", {
				provider: "cursor-not-cloud",
				kind: "oversized",
			});
		}
		const execution = (async () => {
			// The server is waiting on OUR local tool result during this window — no
			// AssistantMessageEvent flows until the handler finishes. Mark the wait
			// as local work so the lazy stream idle watchdog attributes the silence
			// to the tool run instead of aborting a healthy stream (issue #4593).
			const abortController = new AbortController();
			execAbortControllers.set(execMessage.id, abortController);
			const signal = providerSignal
				? AbortSignal.any([providerSignal, abortController.signal])
				: abortController.signal;
			const execContext: CursorExecHandlerContext = { signal };
			try {
				const execWork = handleExecServerMessage(
					execMessage,
					h2Request,
					execHandlers,
					bindCursorToolResultHandler(onToolResult, execContext),
					requestContextTools,
					output,
					stream,
					state,
					execContext,
				);
				await (stream.trackLocalWork?.(execWork) ?? execWork);
			} catch (error) {
				if (!h2Request.closed && !h2Request.destroyed) {
					sendExecClientThrow(
						h2Request,
						execMessage,
						error instanceof Error ? error.message : String(error),
						"client_dispatch_error",
					);
				}
				log("error", "execDispatch", { error: String(error), execId: execMessage.execId });
				if (!execContext.signal?.aborted) throw error;
			} finally {
				if (execAbortControllers.get(execMessage.id) === abortController) {
					execAbortControllers.delete(execMessage.id);
				}
			}
		})();
		execDispatchRegistry.set(execMessage.id, { requestFingerprint, completion: execution });
		await execution;
	} else if (msgCase === "execServerControlMessage") {
		const control = msg.message.value.message;
		if (control.case === "abort") {
			const controller = execAbortControllers.get(control.value.id);
			if (controller) {
				controller.abort();
				log("execServerControl", "abort", { id: control.value.id, cancelled: true });
			} else {
				log("warn", "execServerAbortWithoutExecution", { id: control.value.id });
			}
		}
	} else if (msgCase === "conversationCheckpointUpdate") {
		handleConversationCheckpointUpdate(msg.message.value, output, onConversationCheckpoint);
	} else if (msgCase === "interactionQuery") {
		handleInteractionQuery(msg.message.value, h2Request);
	} else {
		throw new AIError.ProviderResponseError("Cursor sent an unknown required server message variant", {
			provider: "cursor-not-cloud",
			kind: "schema",
		});
	}
}

export function handleKvServerMessage(
	kvMsg: KvServerMessage,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
): void {
	const kvCase = kvMsg.message.case;

	if (kvCase === "getBlobArgs") {
		const blobId = kvMsg.message.value.blobId;
		const blobIdKey = Buffer.from(blobId).toString("hex");

		const blobData = blobStore.get(blobIdKey);

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "getBlobResult",
				value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		writeConnectMessage(h2Request, responseBytes);

		log("kvClient", "getBlobResult", { blobId: blobIdKey.slice(0, 40) });
	} else if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMsg.message.value;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		let error: string | undefined;
		try {
			blobStore.set(blobIdKey, blobData);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "setBlobResult",
				value: create(SetBlobResultSchema, {
					error: error ? create(CursorProtoErrorSchema, { message: error }) : undefined,
				}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		writeConnectMessage(h2Request, responseBytes);

		log("kvClient", "setBlobResult", { blobId: blobIdKey.slice(0, 40), rejected: error !== undefined });
	} else {
		throw new AIError.ProviderResponseError("Cursor sent an unknown KV request variant", {
			provider: "cursor-not-cloud",
			kind: "schema",
		});
	}
}

/** Resolve every current InteractionQuery with a populated, matching response arm. */
export function handleInteractionQuery(query: InteractionQuery, h2Request: http2.ClientHttp2Stream): void {
	const reason = NOT_IMPLEMENTED;
	let result: ReturnType<typeof create<typeof InteractionResponseSchema>>["result"] = { case: undefined };
	switch (query.query.case) {
		case "webSearchRequestQuery":
			result = {
				case: "webSearchRequestResponse",
				value: create(WebSearchRequestResponseSchema, {
					result: {
						case: "rejected",
						value: create(WebSearchRequestResponse_RejectedSchema, { reason }),
					},
				}),
			};
			break;
		case "askQuestionInteractionQuery":
			result = {
				case: "askQuestionInteractionResponse",
				value: create(AskQuestionInteractionResponseSchema, {
					result: create(AskQuestionResultSchema, {
						result: { case: "rejected", value: create(AskQuestionRejectedSchema, { reason }) },
					}),
				}),
			};
			break;
		case "switchModeRequestQuery":
			result = {
				case: "switchModeRequestResponse",
				value: create(SwitchModeRequestResponseSchema, {
					result: {
						case: "rejected",
						value: create(SwitchModeRequestResponse_RejectedSchema, { reason }),
					},
				}),
			};
			break;
		// Legacy OMP fields 5/6 are not present in Cursor 2026.08.04, but
		// retaining typed rejection is harmless for an older peer.
		case "exaSearchRequestQuery":
			result = {
				case: "exaSearchRequestResponse",
				value: create(ExaSearchRequestResponseSchema, {
					result: {
						case: "rejected",
						value: create(ExaSearchRequestResponse_RejectedSchema, { reason }),
					},
				}),
			};
			break;
		case "exaFetchRequestQuery":
			result = {
				case: "exaFetchRequestResponse",
				value: create(ExaFetchRequestResponseSchema, {
					result: {
						case: "rejected",
						value: create(ExaFetchRequestResponse_RejectedSchema, { reason }),
					},
				}),
			};
			break;
		case "createPlanRequestQuery":
			result = {
				case: "createPlanRequestResponse",
				value: create(CreatePlanRequestResponseSchema, {
					result: create(CreatePlanResultSchema, {
						result: { case: "error", value: create(CreatePlanErrorSchema, { error: reason }) },
					}),
				}),
			};
			break;
		case "setupVmEnvironmentArgs":
			throw new AIError.ProviderResponseError(
				"Cursor requested VM setup, which this local provider cannot truthfully perform",
				{
					provider: "cursor-not-cloud",
					kind: "capability",
				},
			);
		default:
			throw new AIError.ProviderResponseError("Cursor sent an unknown interaction query variant", {
				provider: "cursor-not-cloud",
				kind: "schema",
			});
	}

	if (!result.case) {
		throw new AIError.ProviderResponseError("Cursor interaction response had no populated result", {
			provider: "cursor-not-cloud",
			kind: "schema",
		});
	}
	const interactionResponse = create(InteractionResponseSchema, { id: query.id, result });
	const response = create(AgentClientMessageSchema, {
		message: { case: "interactionResponse", value: interactionResponse },
	});
	writeConnectMessage(h2Request, toBinary(AgentClientMessageSchema, response));
	log("interactionResponse", query.query.case, { id: query.id, result: result.case });
}

function sendShellStreamEvent(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	event: ShellStream["event"],
): void {
	sendExecClientMessage(h2Request, execMsg, "shellStream", create(ShellStreamSchema, { event }));
}

function sanitizeShellExecResult(execResult: ShellResult): ShellResult {
	const result = execResult.result;
	if (!result) return execResult;

	switch (result.case) {
		case "success":
		case "failure": {
			const value = result.value;
			return {
				...execResult,
				result: {
					case: result.case,
					value: {
						...value,
						stdout: value.stdout ? sanitizeText(value.stdout) : value.stdout,
						stderr: value.stderr ? sanitizeText(value.stderr) : value.stderr,
					},
				},
			} as ShellResult;
		}
		default:
			return execResult;
	}
}

async function handleShellStreamArgs(
	args: ShellArgs,
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	execContext: CursorExecHandlerContext,
): Promise<void> {
	const normalizedWorkingDirectory = args.workingDirectory || process.cwd();
	const normalizedArgs: ShellArgs = { ...args, workingDirectory: normalizedWorkingDirectory };
	const startTs = performance.now();
	log("shellStream", "start", {
		command: (args as any).command,
		workingDirectory: normalizedWorkingDirectory,
		execId: execMsg.execId,
		hasExecHandlers: !!execHandlers,
		hasShell: !!execHandlers?.shell,
		hasShellStream: !!execHandlers?.shellStream,
	});

	sendShellStreamEvent(h2Request, execMsg, { case: "start", value: create(ShellStreamStartSchema, {}) });

	// Buffer for incomplete ANSI sequences across chunks
	let stdoutBuffer = "";
	let stderrBuffer = "";

	const incompleteEscapeRegex = /\x1b(|\[|\[\d*|\[\?|\[\?\d*|\]\d*;?)$/;

	const flushStdout = () => {
		if (stdoutBuffer) {
			let safeEnd = stdoutBuffer.length;
			const match = stdoutBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stdoutBuffer.length - match[0].length;
			}
			const toSend = stdoutBuffer.slice(0, safeEnd);
			const remaining = stdoutBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stdout",
					value: create(ShellStreamStdoutSchema, { data: sanitizeText(toSend) }),
				});
			}
			stdoutBuffer = remaining;
		}
	};

	const flushStderr = () => {
		if (stderrBuffer) {
			let safeEnd = stderrBuffer.length;
			const match = stderrBuffer.match(incompleteEscapeRegex);
			if (match && match[0].length > 0) {
				safeEnd = stderrBuffer.length - match[0].length;
			}
			const toSend = stderrBuffer.slice(0, safeEnd);
			const remaining = stderrBuffer.slice(safeEnd);
			if (toSend) {
				sendShellStreamEvent(h2Request, execMsg, {
					case: "stderr",
					value: create(ShellStreamStderrSchema, { data: sanitizeText(toSend) }),
				});
			}
			stderrBuffer = remaining;
		}
	};

	let stdoutFlushTimer: NodeJS.Timeout | null = null;
	let stderrFlushTimer: NodeJS.Timeout | null = null;

	const scheduleStdoutFlush = () => {
		if (!stdoutFlushTimer) {
			stdoutFlushTimer = setTimeout(() => {
				stdoutFlushTimer = null;
				flushStdout();
			}, 100);
		}
	};

	const scheduleStderrFlush = () => {
		if (!stderrFlushTimer) {
			stderrFlushTimer = setTimeout(() => {
				stderrFlushTimer = null;
				flushStderr();
			}, 100);
		}
	};

	const streamCallbacks: CursorShellStreamCallbacks = {
		onStdout(data: string) {
			stdoutBuffer += data;
			if (stdoutBuffer.includes("\n") || stdoutBuffer.length > 4096) {
				if (stdoutFlushTimer) {
					clearTimeout(stdoutFlushTimer);
					stdoutFlushTimer = null;
				}
				flushStdout();
			} else {
				scheduleStdoutFlush();
			}
		},
		onStderr(data: string) {
			stderrBuffer += data;
			if (stderrBuffer.includes("\n") || stderrBuffer.length > 4096) {
				if (stderrFlushTimer) {
					clearTimeout(stderrFlushTimer);
					stderrFlushTimer = null;
				}
				flushStderr();
			} else {
				scheduleStderrFlush();
			}
		},
	};

	// Prefer the streaming handler — it forwards output chunks in real time.
	// Falls back to the batch shell handler otherwise.
	const streamHandler = execHandlers?.shellStream
		? (shellArgs: ShellArgs) =>
				raceCursorExecWithAbort(
					execHandlers.shellStream!(shellArgs, streamCallbacks, execContext),
					execContext.signal,
				)
		: undefined;
	const batchHandler = bindCursorExecHandler(execHandlers?.shell, execHandlers, execContext);
	const handler = streamHandler ?? batchHandler;

	const { execResult } = await resolveExecHandler(
		args as any,
		handler as typeof batchHandler,
		onToolResult,
		(toolResult) => buildShellResultFromToolResult(normalizedArgs as any, toolResult),
		(reason) =>
			buildShellRejectedResult((normalizedArgs as any).command, (normalizedArgs as any).workingDirectory, reason),
		(error) =>
			buildShellFailureResult((normalizedArgs as any).command, (normalizedArgs as any).workingDirectory, error),
		{ toolCallId: args.toolCallId, toolName: "bash" },
	);

	// When using the batch handler (no shellStream), send buffered stdout/stderr
	// after execution completes. With shellStream these were already sent in real time.
	const sendBufferedOutput = !streamHandler;
	const sanitizedExecResult = sanitizeShellExecResult(execResult);

	// Flush any remaining buffered output before sending results
	if (stdoutFlushTimer) clearTimeout(stdoutFlushTimer);
	if (stderrFlushTimer) clearTimeout(stderrFlushTimer);
	flushStdout();
	flushStderr();

	sendShellStreamExitFromResult(h2Request, execMsg, sanitizedExecResult, sendBufferedOutput);
	// Cursor can keep the turn pending when it receives only stream deltas.
	// Send the final structured shellResult as completion acknowledgement.
	sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
	sendExecClientStreamClose(h2Request, execMsg);

	log("shellStream", "done", { elapsed: performance.now() - startTs });
}

function sendShellStreamExitFromResult(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	execResult: ShellResult,
	sendBufferedOutput: boolean,
): void {
	const result = execResult.result;
	switch (result.case) {
		case "success": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeText(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeText(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "failure": {
			const value = result.value;
			if (sendBufferedOutput) {
				if (value.stdout) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stdout",
						value: create(ShellStreamStdoutSchema, { data: sanitizeText(value.stdout) }),
					});
				}
				if (value.stderr) {
					sendShellStreamEvent(h2Request, execMsg, {
						case: "stderr",
						value: create(ShellStreamStderrSchema, { data: sanitizeText(value.stderr) }),
					});
				}
			}
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: value.exitCode,
					cwd: value.workingDirectory,
					aborted: value.aborted,
					abortReason: value.abortReason,
				}),
			});
			return;
		}
		case "rejected": {
			sendShellStreamEvent(h2Request, execMsg, { case: "rejected", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		case "timeout": {
			const value = result.value;
			sendShellStreamEvent(h2Request, execMsg, {
				case: "stderr",
				value: create(ShellStreamStderrSchema, {
					data: `Command timed out after ${value.timeoutMs}ms`,
				}),
			});
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: value.workingDirectory,
					aborted: true,
				}),
			});
			return;
		}
		case "permissionDenied": {
			sendShellStreamEvent(h2Request, execMsg, { case: "permissionDenied", value: result.value });
			sendShellStreamEvent(h2Request, execMsg, {
				case: "exit",
				value: create(ShellStreamExitSchema, {
					code: 1,
					cwd: result.value.workingDirectory,
					aborted: false,
				}),
			});
			return;
		}
		default:
			return;
	}
}

function raceCursorExecWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) {
		void work.catch(() => {});
		return Promise.reject(new Error("Cursor server aborted execution"));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("Cursor server aborted execution"));
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

function bindCursorExecHandler<TArgs, TResult>(
	handler:
		| ((args: TArgs, context?: CursorExecHandlerContext) => Promise<CursorExecHandlerResult<TResult>>)
		| undefined,
	owner: CursorExecHandlers | undefined,
	context: CursorExecHandlerContext,
): ((args: TArgs) => Promise<CursorExecHandlerResult<TResult>>) | undefined {
	if (!handler) return undefined;
	return (args) => raceCursorExecWithAbort(handler.call(owner, args, context), context.signal);
}

/**
 * Single-call form of {@link bindCursorExecHandler} for the exec hooks whose
 * result is not a `CursorExecHandlerResult` (MCP approval preflight, MCP
 * resource listing/reads). They await through the same abort race so a hung
 * hook rejects on abort instead of blocking the dispatch — and with it the
 * terminal drain — forever.
 */
function invokeCursorExecHandler<TArgs, TResult>(
	handler: ((args: TArgs, context?: CursorExecHandlerContext) => Promise<TResult>) | undefined,
	owner: CursorExecHandlers | undefined,
	args: TArgs,
	context: CursorExecHandlerContext,
): Promise<TResult | undefined> {
	if (!handler) return Promise.resolve(undefined);
	return raceCursorExecWithAbort(handler.call(owner, args, context), context.signal);
}

/**
 * Bind a result hook to the per-exec abort race, mirroring
 * {@link bindCursorExecHandler}. The hook awaits in `resolveExecHandler` and
 * `pairSynthesizedExecResult` run after the handler finishes, so an unraced
 * hook could hold an otherwise-aborted exec open indefinitely.
 */
function bindCursorToolResultHandler(
	handler: CursorToolResultHandler | undefined,
	context: CursorExecHandlerContext,
): CursorToolResultHandler | undefined {
	if (!handler) return undefined;
	return (toolResult) => raceCursorExecWithAbort(Promise.resolve(handler(toolResult)), context.signal);
}

async function handleExecServerMessage(
	execMsg: ExecServerMessage,
	h2Request: http2.ClientHttp2Stream,
	execHandlers: CursorExecHandlers | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	requestContextTools: McpToolDefinition[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	execContext: CursorExecHandlerContext,
): Promise<void> {
	const execCase = execMsg.message.case;
	log("exec", "dispatch", { execCase, execId: execMsg.execId, hasHandlers: !!execHandlers });
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, {
			rules: [],
			repositoryInfo: [],
			tools: requestContextTools,
			gitRepos: [],
			projectLayouts: [],
			mcpInstructions: [],
			fileContents: {},
			customSubagents: [],
		});

		const requestContextResult = create(RequestContextResultSchema, {
			result: {
				case: "success",
				value: create(RequestContextSuccessSchema, { requestContext }),
			},
		});

		sendExecClientMessage(h2Request, execMsg, "requestContextResult", requestContextResult);
		log("execClient", "requestContextResult");
		return;
	}

	if (!execCase) {
		// A frame carrying a oneof number this build's `agent.proto` does not
		// model at all: protobuf decodes it into unknown fields and leaves
		// `message.case` unset, so the client cannot even name what was asked.
		// Returning silently strands the exec id — the server waits on a reply
		// that never comes. Distinct from the `default:` branch below, which
		// names a frame it recognises but cannot serve.
		log("warn", "unknownExecVariant", { id: execMsg.id, execId: execMsg.execId });
		sendExecClientThrow(h2Request, execMsg, "Unknown exec message variant", "unknown_exec_variant");
		return;
	}

	switch (execCase) {
		case "readArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			// The same composed selector the bridge executes: showing a bare path
			// for a ranged read makes the returned slice look like the whole
			// file in every rebuilt transcript.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", {
				path: piReadDisplayPath(args.path, args.offset, args.limit),
			});
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.read, execHandlers, execContext),
				onToolResult,
				(toolResult) =>
					buildReadResultFromToolResult(
						args.path,
						toolResult,
						args.offset !== undefined || args.limit !== undefined || piReadPathHasRange(args.path),
					),
				(reason) => buildReadRejectedResult(args.path, reason),
				(error) => buildReadErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "readResult", execResult);
			return;
		}
		case "lsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			// Bridge maps `ls` onto the coding-agent `read` tool (see
			// `CursorExecHandlers.ls` in `pi-coding-agent/src/cursor.ts`); mirror
			// that here so the synthesized block matches the toolResult's `toolName`.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "read", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.ls, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildLsResultFromToolResult(args.path, toolResult),
				(reason) => buildLsRejectedResult(args.path, reason),
				(error) => buildLsErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "lsResult", execResult);
			return;
		}
		case "grepArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			// Cursor's model sometimes emits `grepArgs` with an empty `pattern` and a
			// non-empty `glob`, expecting grep to list files matching the glob. Reject
			// that up front with an actionable error so the model retries with a real
			// regex or switches to `ls`/`read`, instead of the local grep tool
			// surfacing a bare "Pattern must not be empty" (issue #4574) after the
			// synthesized block has already been persisted with a placeholder pattern.
			const emptyPatternError = emptyGrepPatternRejection(args.pattern, args.glob);
			if (emptyPatternError !== null) {
				sendExecClientMessage(h2Request, execMsg, "grepResult", buildGrepErrorResult(emptyPatternError));
				return;
			}
			// Mirror the coding-agent bridge's arg mapping so live UI (from
			// `tool_execution_start`) and rebuilt transcript (from this block)
			// display identical args.
			const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "grep", {
				pattern: args.pattern,
				path: searchPath,
				case: args.caseInsensitive === true ? false : undefined,
				skip: piGrepSkip(args.offset),
			});
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.grep, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildGrepResultFromToolResult(args, toolResult),
				(reason) => buildGrepErrorResult(reason),
				(error) => buildGrepErrorResult(error),
				{ toolCallId: args.toolCallId, toolName: "grep" },
			);
			sendExecClientMessage(h2Request, execMsg, "grepResult", execResult);
			return;
		}
		case "writeArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			// Match the bridge: prefer `fileText`, fall back to decoded `fileBytes`.
			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "write", {
				path: args.path,
				content,
			});
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.write, execHandlers, execContext),
				onToolResult,
				(toolResult) =>
					buildWriteResultFromToolResult(
						{
							path: args.path,
							fileText: args.fileText,
							fileBytes: args.fileBytes,
							returnFileContentAfterWrite: args.returnFileContentAfterWrite,
						},
						toolResult,
					),
				(reason) => buildWriteRejectedResult(args.path, reason),
				(error) => buildWriteErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "write" },
			);
			sendExecClientMessage(h2Request, execMsg, "writeResult", execResult);
			return;
		}
		case "deleteArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "delete", { path: args.path });
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.delete, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildDeleteResultFromToolResult(args.path, toolResult),
				(reason) => buildDeleteRejectedResult(args.path, reason),
				(error) => buildDeleteErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "delete" },
			);
			sendExecClientMessage(h2Request, execMsg, "deleteResult", execResult);
			return;
		}
		case "shellArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };
			// Match the bridge (`CursorExecHandlers.shell`): map `workingDirectory`
			// → `cwd`, drop non-positive timeouts.
			const shellTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellTimeout,
			});
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.shell, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildShellResultFromToolResult(normalizedArgs, toolResult),
				(reason) => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				(error) => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
				{ toolCallId: args.toolCallId, toolName: "bash" },
			);
			const sanitizedExecResult = sanitizeShellExecResult(execResult);
			sendExecClientMessage(h2Request, execMsg, "shellResult", sanitizedExecResult);
			return;
		}
		case "shellStreamArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const shellStreamTimeout = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: shellStreamTimeout,
			});
			await handleShellStreamArgs(args, execMsg, h2Request, execHandlers, onToolResult, execContext);
			return;
		}
		case "backgroundShellSpawnArgs": {
			const args = execMsg.message.value;
			const execResult = create(BackgroundShellSpawnResultSchema, {
				result: {
					case: "rejected",
					value: create(ShellRejectedSchema, {
						command: args.command,
						workingDirectory: args.workingDirectory,
						reason: "Not implemented",
						isReadonly: false,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "backgroundShellSpawnResult", execResult);
			return;
		}
		case "writeShellStdinArgs": {
			const execResult = create(WriteShellStdinResultSchema, {
				result: {
					case: "error",
					value: create(WriteShellStdinErrorSchema, {
						error: "Not implemented",
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "writeShellStdinResult", execResult);
			return;
		}
		case "fetchArgs": {
			const args = execMsg.message.value;
			const execResult = create(FetchResultSchema, {
				result: {
					case: "error",
					value: create(FetchErrorSchema, {
						url: args.url,
						error: "Not implemented",
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "fetchResult", execResult);
			return;
		}
		case "diagnosticsArgs": {
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			// Bridge maps `diagnostics` onto the coding-agent `lsp` tool with
			// `action: "diagnostics"` and `file: path`.
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "lsp", {
				action: "diagnostics",
				file: args.path,
			});
			const { execResult } = await resolveExecHandler(
				args,
				bindCursorExecHandler(execHandlers?.diagnostics, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildDiagnosticsResultFromToolResult(args.path, toolResult),
				(reason) => buildDiagnosticsRejectedResult(args.path, reason),
				(error) => buildDiagnosticsErrorResult(args.path, error),
				{ toolCallId: args.toolCallId, toolName: "lsp" },
			);
			sendExecClientMessage(h2Request, execMsg, "diagnosticsResult", execResult);
			return;
		}
		case "mcpArgs": {
			const args = execMsg.message.value;
			const mcpCall = decodeMcpCall(args);
			// An approval probe, not an invocation: the frame asks whether the
			// call would be permitted. Running the tool to find out fires a side
			// effect the user has not been asked about, and fires it again when
			// the real frame follows — so this must answer without executing.
			//
			// The host resolves it against the same policy the wrapper applies at
			// execution time. Only a definite allow is approved: a pending prompt
			// cannot be asked through this frame, and answering yes on its behalf
			// would pre-authorize a call the user never saw. Without a handler
			// there is nothing to decide with, so it is refused. Either way no
			// block is synthesized — nothing ran.
			if (mcpCall.approvalOnly) {
				const approved =
					(await invokeCursorExecHandler(
						execHandlers?.mcpApprovalPreflight,
						execHandlers,
						mcpCall,
						execContext,
					)) === true;
				sendExecClientMessage(
					h2Request,
					execMsg,
					"mcpResult",
					create(McpResultSchema, {
						result: approved
							? { case: "approved", value: create(McpApprovedSchema, {}) }
							: {
									case: "rejected",
									value: create(McpRejectedSchema, {
										reason: `Tool "${mcpCall.toolName || mcpCall.name}" is not approved to run without asking.`,
									}),
								},
					}),
				);
				return;
			}
			if (execHandlers?.mcp) {
				const existingBlock = output.content.find(
					(block) => block.type === "toolCall" && block.id === mcpCall.toolCallId,
				);
				if (existingBlock) {
					markCursorExecResolved(existingBlock);
				} else {
					synthesizeCursorExecToolCall(
						output,
						stream,
						state,
						mcpCall.toolCallId,
						mcpCall.toolName || mcpCall.name,
						mcpCall.args,
					);
					state.resolvedMcpToolCallIds.add(mcpCall.toolCallId);
				}
			}
			const { execResult } = await resolveExecHandler(
				mcpCall,
				bindCursorExecHandler(execHandlers?.mcp, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildMcpResultFromToolResult(mcpCall, toolResult),
				(_reason) => buildMcpToolNotFoundResult(mcpCall),
				(error) => buildMcpErrorResult(error),
				execHandlers?.mcp ? { toolCallId: mcpCall.toolCallId, toolName: mcpCall.toolName } : null,
			);
			sendExecClientMessage(h2Request, execMsg, "mcpResult", execResult);
			return;
		}
		case "listMcpResourcesExecArgs": {
			// A host holding live MCP connections answers from them; without a
			// handler the honest answer is an explicit empty success. An
			// unset-oneof result would read as "the call produced nothing".
			const args = execMsg.message.value;
			let execResult: ListMcpResourcesExecResult;
			// The model consumes this catalog, so it needs a block and a paired
			// result or the listing is invisible in the UI and gone from every
			// rebuilt history. Only synthesized when a handler exists: without
			// one the frame is a fixed empty answer that executed nothing.
			const toolCallId = execHandlers?.listMcpResources ? crypto.randomUUID() : undefined;
			if (toolCallId) {
				synthesizeCursorExecToolCall(output, stream, state, toolCallId, "list_mcp_resources", {
					server: args.server,
				});
			}
			try {
				const resources =
					(await invokeCursorExecHandler(
						execHandlers?.listMcpResources,
						execHandlers,
						{ server: args.server },
						execContext,
					)) ?? [];
				execResult = create(ListMcpResourcesExecResultSchema, {
					result: {
						case: "success",
						value: create(ListMcpResourcesSuccessSchema, {
							resources: resources.map((resource) =>
								create(ListMcpResourcesExecResult_McpResourceSchema, {
									uri: resource.uri,
									name: resource.name,
									description: resource.description,
									mimeType: resource.mimeType,
									server: resource.server,
								}),
							),
						}),
					},
				});
			} catch (error) {
				execResult = create(ListMcpResourcesExecResultSchema, {
					result: {
						case: "error",
						value: create(ListMcpResourcesErrorSchema, {
							error: error instanceof Error ? error.message : String(error),
						}),
					},
				});
			}
			if (toolCallId) {
				// Derived from the answer that goes on the wire, so the block can
				// never disagree with what the model was told.
				const settled = execResult.result;
				const text =
					settled.case === "success"
						? formatListedMcpResources(settled.value.resources)
						: settled.case === "error"
							? settled.value.error || "Failed to list MCP resources"
							: (settled.value?.reason ?? "Failed to list MCP resources");
				await pairSynthesizedExecResult(
					state,
					onToolResult,
					toolCallId,
					"list_mcp_resources",
					text,
					settled.case !== "success",
				);
			}
			sendExecClientMessage(h2Request, execMsg, "listMcpResourcesExecResult", execResult);
			return;
		}
		case "readMcpResourceExecArgs": {
			const args = execMsg.message.value;
			let execResult: ReadMcpResourceExecResult;
			// The read runs locally, and in download mode it writes a workspace
			// file — an operation with no transcript block is invisible in the UI
			// and absent from every rebuilt history. Only synthesized when a
			// handler exists: without one the frame is a fixed `not_found` that
			// executed nothing, and a block would claim work that never happened.
			const toolCallId = execHandlers?.readMcpResource ? crypto.randomUUID() : undefined;
			if (toolCallId) {
				synthesizeCursorExecToolCall(output, stream, state, toolCallId, "read_mcp_resource", {
					server: args.server,
					uri: args.uri,
					download_path: args.downloadPath,
				});
			}
			try {
				// `null` is the handler's "no such server or uri", which is exactly
				// `not_found`; a throw is a real failure and must not masquerade as
				// a missing resource.
				const content = await invokeCursorExecHandler(
					execHandlers?.readMcpResource,
					execHandlers,
					{
						server: args.server,
						uri: args.uri,
						downloadPath: args.downloadPath,
					},
					execContext,
				);
				execResult = content
					? create(ReadMcpResourceExecResultSchema, {
							result: {
								case: "success",
								value: create(ReadMcpResourceSuccessSchema, {
									uri: content.uri,
									name: content.name,
									description: content.description,
									mimeType: content.mimeType,
									downloadPath: content.downloadPath,
									// A download returns no content to the model: the file is
									// on disk and the path is the answer. Otherwise the wire's
									// content oneof carries one of the two, text winning when
									// a host supplies both.
									content:
										content.downloadPath !== undefined
											? { case: undefined }
											: content.text !== undefined
												? { case: "text", value: content.text }
												: content.blob !== undefined
													? { case: "blob", value: content.blob }
													: { case: undefined },
								}),
							},
						})
					: create(ReadMcpResourceExecResultSchema, {
							result: { case: "notFound", value: create(ReadMcpResourceNotFoundSchema, { uri: args.uri }) },
						});
			} catch (error) {
				execResult = create(ReadMcpResourceExecResultSchema, {
					result: {
						case: "error",
						value: create(ReadMcpResourceErrorSchema, {
							uri: args.uri,
							error: error instanceof Error ? error.message : String(error),
						}),
					},
				});
			}
			if (toolCallId) {
				// Derived from the answer that actually goes on the wire, so no exit
				// can drift out of sync with what the model was told.
				const settled = execResult.result;
				let text: string;
				switch (settled.case) {
					case "success":
						text = settled.value.downloadPath
							? `Downloaded ${args.uri} to ${settled.value.downloadPath}`
							: `Read ${args.uri}`;
						break;
					case "notFound":
						text = `No such resource: ${args.uri}`;
						break;
					// The wire union carries a refusal variant this client never
					// builds today — the handler answers content or `null`. Handled
					// anyway so the switch stays total: it holds a `reason`, not an
					// `error`, so a collapsed default would have read `undefined`.
					case "rejected":
						text = `Refused: ${settled.value.reason}`;
						break;
					default:
						text = settled.value?.error ?? `Failed to read ${args.uri}`;
						break;
				}
				await pairSynthesizedExecResult(
					state,
					onToolResult,
					toolCallId,
					"read_mcp_resource",
					text,
					settled.case !== "success",
				);
			}
			sendExecClientMessage(h2Request, execMsg, "readMcpResourceExecResult", execResult);
			return;
		}
		case "recordScreenArgs": {
			const execResult = create(RecordScreenResultSchema, {
				result: { case: "failure", value: create(RecordScreenFailureSchema, { error: NOT_IMPLEMENTED }) },
			});
			sendExecClientMessage(h2Request, execMsg, "recordScreenResult", execResult);
			return;
		}
		case "computerUseArgs": {
			const execResult = create(ComputerUseResultSchema, {
				result: { case: "error", value: create(ComputerUseErrorSchema, { error: NOT_IMPLEMENTED }) },
			});
			sendExecClientMessage(h2Request, execMsg, "computerUseResult", execResult);
			return;
		}
		case "piReadArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			// The displayed block must show the operation that actually runs: the
			// bridge composes the same range selector onto the path.
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "read", {
				path: piReadDisplayPath(args.path, args.offset, args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piRead, execHandlers, execContext),
				onToolResult,
				buildPiReadResult,
				buildPiReadError,
				buildPiReadError,
				{ toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "piReadResult", execResult);
			return;
		}
		case "piBashArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "bash", {
				command: args.command,
				timeout: piTimeout(args.timeout),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piBash, execHandlers, execContext),
				onToolResult,
				buildPiBashResult,
				buildPiBashError,
				buildPiBashError,
				{ toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "piBashResult", execResult);
			return;
		}
		case "piEditArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			// `PiEditReplacement` maps onto the local `edit` tool's replace mode:
			// one snake_case `old_string`/`new_string` per call. Multi-replacement
			// frames display the first replacement; the exec handler applies all.
			const firstEdit = args.edits[0];
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "edit", {
				path: args.path,
				old_string: firstEdit?.oldText ?? "",
				new_string: firstEdit?.newText ?? "",
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piEdit, execHandlers, execContext),
				onToolResult,
				buildPiEditResult,
				buildPiEditRejected,
				buildPiEditError,
				{ toolCallId, toolName: "edit" },
			);
			sendExecClientMessage(h2Request, execMsg, "piEditResult", execResult);
			return;
		}
		case "piWriteArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "write", {
				path: args.path,
				content: args.content,
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piWrite, execHandlers, execContext),
				onToolResult,
				buildPiWriteResult,
				buildPiWriteRejected,
				buildPiWriteError,
				{ toolCallId, toolName: "write" },
			);
			sendExecClientMessage(h2Request, execMsg, "piWriteResult", execResult);
			return;
		}
		case "piGrepArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "grep", {
				pattern: args.literal === true ? piEscapeRegexLiteral(args.pattern) : args.pattern,
				path: args.glob ? piJoinPath(args.path, args.glob) : args.path || ".",
				case: args.ignoreCase === true ? false : undefined,
				// Neither field exists in the model-facing `grep` schema — the bridge
				// serves them by building a scoped tool instead. Recorded anyway, for
				// the same reason `pi_read` renders its range into the displayed path:
				// a capped or context-widened search is otherwise replayed as an
				// ordinary grep sitting next to output no ordinary grep produces.
				context: args.context,
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piGrep, execHandlers, execContext),
				onToolResult,
				buildPiGrepResult,
				buildPiGrepError,
				buildPiGrepError,
				{ toolCallId, toolName: "grep" },
			);
			sendExecClientMessage(h2Request, execMsg, "piGrepResult", execResult);
			return;
		}
		case "piFindArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "glob", {
				path: piJoinPath(args.path, args.pattern),
				limit: piLimit(args.limit),
			});
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piFind, execHandlers, execContext),
				onToolResult,
				buildPiFindResult,
				buildPiFindError,
				buildPiFindError,
				{ toolCallId, toolName: "glob" },
			);
			sendExecClientMessage(h2Request, execMsg, "piFindResult", execResult);
			return;
		}
		case "piLsArgs": {
			const args = execMsg.message.value;
			const toolCallId = crypto.randomUUID();
			// Same mapping as the legacy `lsArgs` frame: the local `read` tool lists
			// directories, so the synthesized block must name `read` to match the
			// bridge's own `toolResult`.
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "read", { path: piLsPath(args.path) });
			const { execResult } = await resolveExecHandler(
				{ args, toolCallId },
				bindCursorExecHandler(execHandlers?.piLs, execHandlers, execContext),
				onToolResult,
				buildPiLsResult,
				buildPiLsError,
				buildPiLsError,
				{ toolCallId, toolName: "read" },
			);
			sendExecClientMessage(h2Request, execMsg, "piLsResult", execResult);
			return;
		}
		case "miniSweAgentBashArgs": {
			// Same `ShellArgs`/`ShellResult` pair as `shellArgs`, under its own frame
			// number, so the existing shell handler answers it unchanged.
			const args = execMsg.message.value;
			if (!args.toolCallId) args.toolCallId = crypto.randomUUID();
			const normalizedArgs: ShellArgs = { ...args, workingDirectory: args.workingDirectory || process.cwd() };
			synthesizeCursorExecToolCall(output, stream, state, args.toolCallId, "bash", {
				command: args.command,
				cwd: args.workingDirectory || undefined,
				timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
			});
			const { execResult } = await resolveExecHandler(
				normalizedArgs,
				bindCursorExecHandler(execHandlers?.shell, execHandlers, execContext),
				onToolResult,
				(toolResult) => buildShellResultFromToolResult(normalizedArgs, toolResult),
				(reason) => buildShellRejectedResult(normalizedArgs.command, normalizedArgs.workingDirectory, reason),
				(error) => buildShellFailureResult(normalizedArgs.command, normalizedArgs.workingDirectory, error),
				{ toolCallId: args.toolCallId, toolName: "bash" },
			);
			sendExecClientMessage(h2Request, execMsg, "miniSweAgentBashResult", sanitizeShellExecResult(execResult));
			return;
		}
		case "redactedReadArgs": {
			// Same `ReadArgs`/`ReadResult` pair as `readArgs`, but the server expects
			// the client to strip secrets from the content first. No redaction is
			// implemented here, and serving a plain read would hand back exactly the
			// unredacted bytes the frame exists to withhold.
			const args = execMsg.message.value;
			sendExecClientMessage(
				h2Request,
				execMsg,
				"redactedReadResult",
				buildReadErrorResult(args.path, "Secret redaction is not implemented by this client"),
			);
			return;
		}
		case "mcpStateExecArgs": {
			const args = execMsg.message.value;
			sendExecClientMessage(
				h2Request,
				execMsg,
				"mcpStateExecResult",
				buildMcpStateResult(requestContextTools, args.serverIdentifiers),
			);
			return;
		}
		case "executeHookArgs": {
			const args = execMsg.message.value;
			const execResult = buildNeutralHookResult(args.request);
			if (!execResult) {
				sendExecClientThrow(
					h2Request,
					execMsg,
					`Unsupported hook request: ${args.request?.request.case ?? "unset"}`,
					"unknown_hook_request",
				);
				return;
			}
			sendExecClientMessage(h2Request, execMsg, "executeHookResult", execResult);
			return;
		}
		case "subagentArgs": {
			const args = execMsg.message.value;
			const execResult = create(SubagentResultSchema, {
				result: {
					case: "error",
					value: create(SubagentErrorSchema, { error: `Subagents are ${NOT_IMPLEMENTED_SUFFIX}` }),
				},
			});
			log("exec", "subagentRejected", { subagentType: args.subagentType });
			sendExecClientMessage(h2Request, execMsg, "subagentResult", execResult);
			return;
		}
		case "subagentAwaitArgs": {
			// No subagent was ever spawned, so every awaited id is genuinely unknown.
			const args = execMsg.message.value;
			const execResult = create(SubagentAwaitResultSchema, {
				result: {
					case: "notFound",
					value: create(SubagentAwaitNotFoundSchema, { agentId: args.agentId }),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "subagentAwaitResult", execResult);
			return;
		}
		case "forceBackgroundShellArgs": {
			// Backgrounding targets a running tool call by id. This client runs every
			// shell to completion in band, so there is never one to move.
			const execResult = create(ForceBackgroundShellResultSchema, {
				status: ForceBackgroundShellStatus.NOT_FOUND,
			});
			sendExecClientMessage(h2Request, execMsg, "forceBackgroundShellResult", execResult);
			return;
		}
		case "forceBackgroundSubagentArgs": {
			const execResult = create(ForceBackgroundSubagentResultSchema, {
				status: ForceBackgroundSubagentStatus.NOT_FOUND,
			});
			sendExecClientMessage(h2Request, execMsg, "forceBackgroundSubagentResult", execResult);
			return;
		}
		case "smartModeClassifierArgs": {
			// The classifier decides whether a risky action needs approval. Answering
			// `ALLOW` would silently wave through actions the server asked us to
			// judge, so the honest answer is that no classifier exists here.
			const execResult = create(SmartModeClassifierResultSchema, {
				result: {
					case: "error",
					value: create(SmartModeClassifierErrorSchema, {
						error: `Smart-mode classification is ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "smartModeClassifierResult", execResult);
			return;
		}
		case "canvasDiagnosticsArgs": {
			const args = execMsg.message.value;
			const execResult = create(CanvasDiagnosticsResultSchema, {
				result: {
					case: "error",
					value: create(CanvasDiagnosticsErrorSchema, {
						path: args.path,
						error: `Canvas diagnostics are ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "canvasDiagnosticsResult", execResult);
			return;
		}
		case "shellAllowlistPrecheckArgs": {
			// The prechecks ask "is this pre-approved, so may it skip the approval
			// prompt?". This client keeps no allowlist, so the answer is always no:
			// `false` costs an approval round-trip, `true` would grant one that was
			// never configured.
			sendExecClientMessage(
				h2Request,
				execMsg,
				"shellAllowlistPrecheckResult",
				create(ShellAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "mcpAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"mcpAllowlistPrecheckResult",
				create(McpAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "webFetchAllowlistPrecheckArgs": {
			sendExecClientMessage(
				h2Request,
				execMsg,
				"webFetchAllowlistPrecheckResult",
				create(WebFetchAllowlistPrecheckResultSchema, { allowlisted: false }),
			);
			return;
		}
		case "conversationSearchArgs": {
			// Cursor conversation history lives server-side; this client keeps no
			// local index of it to search.
			//
			// The streamed `search_conversations_tool_call` envelope announces this
			// call but the interaction decoder builds no block for it, so the block
			// and its paired result are synthesized here — exactly like every other
			// exec frame. Without the pair, `buildSessionContext` strips the whole
			// interaction on replay. The frame carries its own `tool_call_id`, so
			// the streamed announcement and this block agree on the key.
			const args = execMsg.message.value;
			const toolCallId = args.toolCallId || crypto.randomUUID();
			const error = `Conversation search is ${NOT_IMPLEMENTED_SUFFIX}`;
			synthesizeCursorExecToolCall(output, stream, state, toolCallId, "search_conversations", {
				query: args.query,
				limit: args.limit,
			});
			await pairSynthesizedExecResult(state, onToolResult, toolCallId, "search_conversations", error);
			const execResult = create(ConversationSearchResultSchema, {
				result: { case: "error", value: create(ConversationSearchErrorSchema, { error }) },
			});
			sendExecClientMessage(h2Request, execMsg, "conversationSearchResult", execResult);
			return;
		}
		case "agentStoreConflictArgs": {
			// The agent store is Cursor's own on-disk journal; this client never
			// writes one, so it has no conflict events to replay.
			const execResult = create(AgentStoreConflictResultSchema, {
				result: {
					case: "error",
					value: create(AgentStoreConflictErrorSchema, {
						error: `Agent store conflicts are ${NOT_IMPLEMENTED_SUFFIX}`,
					}),
				},
			});
			sendExecClientMessage(h2Request, execMsg, "agentStoreConflictResult", execResult);
			return;
		}
		case "gitDiffRequest": {
			// `GetDiffResponse` has no error variant: it models five output formats
			// plus before/after file contents and nothing else. Any in-band answer is
			// therefore a claim that a diff was computed, so a `throw` is the only
			// truthful reply.
			sendExecClientThrow(h2Request, execMsg, `Git diff is ${NOT_IMPLEMENTED_SUFFIX}`, "exec_variant_unsupported");
			return;
		}
		default: {
			// A frame number this build recognises structurally but has no answer
			// for. Distinct from the unset-case path above: there the client cannot
			// even name the frame.
			log("warn", "unhandledExecMessage", { execCase });
			sendExecClientThrow(
				h2Request,
				execMsg,
				`No handler for exec message of type ${execCase}`,
				"exec_variant_unsupported",
			);
		}
	}
}

/**
 * Send one typed answer on the exec channel.
 *
 * `ExecClientMessage["message"]` is a discriminated union pairing each case
 * with its own result type, so the generic is keyed on the case: passing a
 * `ReadResult` under `"shellResult"` is a compile error rather than a wire
 * message the server rejects at runtime.
 */
function sendExecClientMessage<TCase extends NonNullable<ExecClientMessage["message"]["case"]>>(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	messageCase: TCase,
	value: Extract<ExecClientMessage["message"], { case: TCase }>["value"],
): void {
	const execClientMessage = create(ExecClientMessageSchema, {
		id: execMsg.id,
		execId: execMsg.execId,
		message: { case: messageCase, value } as ExecClientMessage["message"],
	});

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientMessage", value: execClientMessage },
	});

	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	writeConnectMessage(h2Request, responseBytes);

	log("execClientMessage", messageCase, value);
}

/**
 * Fail one exec frame in band.
 *
 * `ExecClientThrow` is the protocol's failure channel for a frame that cannot
 * be answered at all — as opposed to a frame answered with its own typed error
 * variant, which means "the tool ran and failed". Cursor's own executor sends
 * exactly this for a frame no handler claims
 * (`agent-exec/dist/index.js`: `No handler found for server message of type …`
 * → `case: 'throw'` then `streamClose`), so the server already knows how to
 * recover from it: it surfaces the error to the model instead of blocking on a
 * reply that never comes.
 *
 * The alternative this replaces — writing an `ExecClientMessage` whose `message`
 * oneof is unset — is not a valid answer: the server sees a reply carrying no
 * result and cannot tell it apart from a malformed frame.
 */
function sendExecClientThrow(
	h2Request: http2.ClientHttp2Stream,
	execMsg: ExecServerMessage,
	error: string,
	errorCode?: string,
): void {
	const controlMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "throw",
			value: create(ExecClientThrowSchema, { id: execMsg.id, error, errorCode }),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: controlMessage },
	});
	writeConnectMessage(h2Request, toBinary(AgentClientMessageSchema, clientMessage));
	log("execClientControl", "throw", { id: execMsg.id, execId: execMsg.execId, error, errorCode });
	sendExecClientStreamClose(h2Request, execMsg);
}

function sendExecClientStreamClose(h2Request: http2.ClientHttp2Stream, execMsg: ExecServerMessage): void {
	const closeMessage = create(ExecClientControlMessageSchema, {
		message: {
			case: "streamClose",
			value: create(ExecClientStreamCloseSchema, {
				id: execMsg.id,
			}),
		},
	});
	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "execClientControlMessage", value: closeMessage },
	});
	const responseBytes = toBinary(AgentClientMessageSchema, clientMessage);
	writeConnectMessage(h2Request, responseBytes);
	log("execClientControl", "streamClose", { id: execMsg.id, execId: execMsg.execId });
}

/**
 * Exported for tests: verifies handler is invoked with correct `this` when passed as bound.
 *
 * Every exit pairs a `toolResult`. The synthesized block was already marked
 * `kCursorExecResolved` before this runs (`synthesizeCursorExecToolCall`), so
 * `agent-loop.ts` emits no placeholder for it: a path that returns without a
 * result leaves the call unpaired and `buildSessionContext` strips the whole
 * interaction on replay. The three result-less paths — no handler installed, a
 * handler that produced nothing, and a thrown handler — therefore synthesize
 * one from the same text the server sees in `execResult`.
 *
 * `pairing` is required so a new callsite cannot silently recreate the orphan,
 * and nullable for the one caller whose block is NOT pre-resolved: MCP without
 * an `mcp` handler, which `agent-loop.ts` runs locally and pairs itself.
 */
export async function resolveExecHandler<TArgs, TResult>(
	args: TArgs,
	handler: ((args: TArgs) => Promise<CursorExecHandlerResult<TResult>>) | undefined,
	onToolResult: CursorToolResultHandler | undefined,
	buildFromToolResult: (toolResult: ToolResultMessage) => TResult,
	buildRejected: (reason: string) => TResult,
	buildError: (error: string) => TResult,
	pairing: CursorExecPairing | null,
): Promise<{ execResult: TResult; toolResult?: ToolResultMessage }> {
	const pair = async (text: string, isError: boolean): Promise<ToolResultMessage | undefined> => {
		// `null` only for MCP without a handler: that block is never marked
		// resolved, so `agent-loop.ts` runs it locally and pairs its own result.
		// Synthesizing one here would double up.
		if (!pairing) return undefined;
		const synthesized: ToolResultMessage = {
			role: "toolResult",
			toolCallId: pairing.toolCallId,
			toolName: pairing.toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.now(),
		};
		return await applyToolResultHandler(synthesized, onToolResult);
	};

	if (!handler) {
		const reason = "Tool not available";
		return { execResult: buildRejected(reason), toolResult: await pair(reason, true) };
	}

	try {
		const handlerResult = await handler(args);
		const { execResult, toolResult } = splitExecHandlerResult(handlerResult);
		const finalToolResult = await applyToolResultHandler(toolResult, onToolResult);

		if (execResult) {
			// TResult-only is a supported return form, so the transcript entry has to
			// be synthesized here. Deriving its state from the raw result keeps the
			// two views consistent: every exec result is a proto oneof whose only
			// non-failure variant is `success`, so a `rejected`/`error`/
			// `file_not_found`/... result must not be recorded as a successful call.
			return {
				execResult,
				toolResult: finalToolResult ?? (await pair(...describeExecResult(execResult))),
			};
		}
		if (finalToolResult) {
			return { execResult: buildFromToolResult(finalToolResult), toolResult: finalToolResult };
		}
		const reason = "Tool returned no result";
		return { execResult: buildRejected(reason), toolResult: await pair(reason, true) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { execResult: buildError(message), toolResult: await pair(message, true) };
	}
}

/**
 * Derive the transcript state of an exec result the SDK handler returned in the
 * TResult-only form, which carries no `toolResult` to copy it from.
 *
 * Every exec result in `agent.proto` is a `oneof result` whose success variant
 * is named `success` — the rest (`error`, `rejected`, `file_not_found`,
 * `permission_denied`, `invalid_file`, ...) are failures. Recording those as a
 * successful call would show the user a green entry for a call Cursor was told
 * failed. The variant's own `error`/`reason` text is the same string the server
 * receives, so it is reused verbatim as the transcript body.
 *
 * MCP is the one shape where `success` is not enough: `McpSuccess.is_error`
 * carries an application-level tool failure inside the success variant
 * (`agent.proto:2058`), mirroring the MCP spec's own `isError`. The transport
 * succeeded, the tool did not — so the entry must be a failure, and its text
 * comes from the payload's own content rather than a placeholder.
 */
function describeExecResult(execResult: unknown): [text: string, isError: boolean] {
	const result = (execResult as { result?: { case?: string; value?: unknown } } | null)?.result;
	const variant = result?.case;
	if (variant === "success") {
		const success = result?.value as { isError?: boolean; content?: unknown[] } | undefined;
		if (!success?.isError) return ["Tool produced no transcript result", false];
		return [mcpContentToText(success.content) || "MCP tool reported an error", true];
	}
	if (!variant) return ["Tool produced no transcript result", false];
	const value = result?.value as { error?: string; reason?: string } | undefined;
	return [value?.error || value?.reason || `Tool call ${variant}`, true];
}

/**
 * Flatten `McpSuccess.content` into transcript text. Image items carry no text
 * to surface, so only the text variant contributes; an all-image failure falls
 * back to the caller's generic message.
 */
function mcpContentToText(content: unknown[] | undefined): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const inner = (item as { content?: { case?: string; value?: { text?: string } } } | null)?.content;
		if (inner?.case === "text" && inner.value?.text) parts.push(inner.value.text);
	}
	return parts.join("\n");
}

function splitExecHandlerResult<TResult>(result: CursorExecHandlerResult<TResult>): {
	execResult?: TResult;
	toolResult?: ToolResultMessage;
} {
	if (isToolResultMessage(result)) {
		return { toolResult: result };
	}
	if (result && typeof result === "object") {
		const record = result as Record<string, unknown>;
		if ("execResult" in record) {
			const { execResult, toolResult } = record as {
				execResult: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("toolResult" in record && !isToolResultMessage(record)) {
			const { result: execResult, toolResult } = record as {
				result?: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
		if ("result" in record && !("$typeName" in record)) {
			const { result: execResult, toolResult } = record as {
				result: TResult;
				toolResult?: ToolResultMessage;
			};
			return { execResult, toolResult };
		}
	}
	return { execResult: result as TResult };
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
	return !!value && typeof value === "object" && (value as ToolResultMessage).role === "toolResult";
}

async function applyToolResultHandler(
	toolResult: ToolResultMessage | undefined,
	onToolResult: CursorToolResultHandler | undefined,
): Promise<ToolResultMessage | undefined> {
	if (!toolResult || !onToolResult) {
		return toolResult;
	}
	const updated = await onToolResult(toolResult);
	return updated ?? toolResult;
}

function toolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

/**
 * The catalog as the paired transcript result records it.
 *
 * Cursor receives every resource's identity on the wire, but rebuilt history is
 * serialized from this local result — so recording only a count leaves the
 * model, one reload later, aware that it once saw N resources and unable to
 * name any of them. The URI is what a follow-up `read_mcp_resource` needs, so
 * it leads; name and mime type follow only when the server supplied them.
 */
function formatListedMcpResources(
	resources: { uri: string; name?: string; mimeType?: string; server?: string }[],
): string {
	if (resources.length === 0) return "No MCP resources available";
	const lines = resources.map((resource) => {
		const qualifiers = [resource.name, resource.mimeType].filter((part) => !!part).join(", ");
		const server = resource.server ? `[${resource.server}] ` : "";
		return qualifiers ? `- ${server}${resource.uri} (${qualifiers})` : `- ${server}${resource.uri}`;
	});
	return [`Listed ${resources.length} MCP resource(s):`, ...lines].join("\n");
}

function toolResultWasTruncated(toolResult: ToolResultMessage): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const truncation = (toolResult.details as { truncation?: { truncated?: boolean } }).truncation;
	return !!truncation?.truncated;
}

function toolResultDetailBoolean(toolResult: ToolResultMessage, key: string): boolean {
	if (!toolResult.details || typeof toolResult.details !== "object") {
		return false;
	}
	const value = (toolResult.details as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : false;
}

/**
 * The file's own line count, when the tool recorded one.
 *
 * Read results expose the source-wide count directly when known. Older tool
 * results carry it at `details.meta.truncation.totalLines`; the flat
 * `details.truncation.totalLines` counts from a window's start and is
 * deliberately not consulted here.
 */
function readTotalLinesFromDetails(toolResult: ToolResultMessage): number | undefined {
	const details = toolResult.details;
	if (!details || typeof details !== "object") return undefined;
	const direct = "totalLines" in details ? details.totalLines : undefined;
	if (typeof direct === "number" && Number.isFinite(direct)) return direct;
	const meta = "meta" in details ? details.meta : undefined;
	if (!meta || typeof meta !== "object") return undefined;
	const truncation = "truncation" in meta ? meta.truncation : undefined;
	if (!truncation || typeof truncation !== "object") return undefined;
	const totalLines = "totalLines" in truncation ? truncation.totalLines : undefined;
	return typeof totalLines === "number" && Number.isFinite(totalLines) ? totalLines : undefined;
}

function readFileSizeFromDetails(toolResult: ToolResultMessage): number | undefined {
	const details = toolResult.details;
	if (!details || typeof details !== "object" || !("fileSize" in details)) return undefined;
	const { fileSize } = details;
	return typeof fileSize === "number" && Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : undefined;
}

function buildReadResultFromToolResult(path: string, toolResult: ToolResultMessage, rangeApplied = false) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildReadErrorResult(path, text || "Read failed");
	}
	// Counting the payload is only the file's length when the payload is the
	// whole file. Under a composed window it is the window's, and answering a
	// 20-line page of a 100-line file with `total_lines: 20` tells a paginating
	// server it has reached the end.
	const totalLines = readTotalLinesFromDetails(toolResult) ?? (rangeApplied ? 0 : text ? text.split("\n").length : 0);
	return create(ReadResultSchema, {
		result: {
			case: "success",
			value: create(ReadSuccessSchema, {
				path,
				totalLines,
				fileSize: BigInt(readFileSizeFromDetails(toolResult) ?? Buffer.byteLength(text, "utf-8")),
				truncated: toolResultWasTruncated(toolResult),
				output: { case: "content", value: text },
				// Set when this client composed the frame's window onto the read,
				// left false when it read the file whole. The proto names the
				// field but nothing here pins the server's use of it, so the only
				// safe contract is that it describes what we actually did.
				rangeApplied,
			}),
		},
	});
}

function buildReadErrorResult(path: string, error: string) {
	return create(ReadResultSchema, {
		result: {
			case: "error",
			value: create(ReadErrorSchema, { path, error }),
		},
	});
}

function buildReadRejectedResult(path: string, reason: string) {
	return create(ReadResultSchema, {
		result: {
			case: "rejected",
			value: create(ReadRejectedSchema, { path, reason }),
		},
	});
}

function buildWriteResultFromToolResult(
	args: { path: string; fileText?: string; fileBytes?: Uint8Array; returnFileContentAfterWrite?: boolean },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildWriteErrorResult(args.path, text || "Write failed");
	}
	const fileText = args.fileText ?? "";
	const fileSize = args.fileBytes?.length ?? Buffer.byteLength(fileText, "utf-8");
	const linesCreated = fileText ? fileText.split("\n").length : 0;
	return create(WriteResultSchema, {
		result: {
			case: "success",
			value: create(WriteSuccessSchema, {
				path: args.path,
				linesCreated,
				fileSize,
				fileContentAfterWrite: args.returnFileContentAfterWrite ? fileText : undefined,
			}),
		},
	});
}

function buildWriteErrorResult(path: string, error: string) {
	return create(WriteResultSchema, {
		result: {
			case: "error",
			value: create(WriteErrorSchema, { path, error }),
		},
	});
}

function buildWriteRejectedResult(path: string, reason: string) {
	return create(WriteResultSchema, {
		result: {
			case: "rejected",
			value: create(WriteRejectedSchema, { path, reason }),
		},
	});
}

function buildDeleteResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDeleteErrorResult(path, text || "Delete failed");
	}
	return create(DeleteResultSchema, {
		result: {
			case: "success",
			value: create(DeleteSuccessSchema, {
				path,
				deletedFile: path,
				fileSize: BigInt(0),
				prevContent: "",
			}),
		},
	});
}

function buildDeleteErrorResult(path: string, error: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "error",
			value: create(DeleteErrorSchema, { path, error }),
		},
	});
}

function buildDeleteRejectedResult(path: string, reason: string) {
	return create(DeleteResultSchema, {
		result: {
			case: "rejected",
			value: create(DeleteRejectedSchema, { path, reason }),
		},
	});
}

function buildShellResultFromToolResult(
	args: { command: string; workingDirectory: string },
	toolResult: ToolResultMessage,
) {
	const output = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildShellFailureResult(args.command, args.workingDirectory, output || "Shell failed");
	}
	return create(ShellResultSchema, {
		result: {
			case: "success",
			value: create(ShellSuccessSchema, {
				command: args.command,
				workingDirectory: args.workingDirectory,
				exitCode: 0,
				signal: "",
				stdout: output,
				stderr: "",
				executionTime: 0,
			}),
		},
	});
}

function buildShellFailureResult(command: string, workingDirectory: string, error: string) {
	return create(ShellResultSchema, {
		result: {
			case: "failure",
			value: create(ShellFailureSchema, {
				command,
				workingDirectory,
				exitCode: 1,
				signal: "",
				stdout: "",
				stderr: error,
				executionTime: 0,
				aborted: false,
			}),
		},
	});
}

function buildShellRejectedResult(command: string, workingDirectory: string, reason: string) {
	return create(ShellResultSchema, {
		result: {
			case: "rejected",
			value: create(ShellRejectedSchema, {
				command,
				workingDirectory,
				reason,
				isReadonly: false,
			}),
		},
	});
}

function buildLsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildLsErrorResult(path, text || "Ls failed");
	}
	const rootPath = path || ".";
	const entries = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("["));
	const childrenDirs: LsDirectoryTreeNode[] = [];
	const childrenFiles: LsDirectoryTreeNode_File[] = [];

	for (const entry of entries) {
		const name = entry.split(" (")[0];
		if (name.endsWith("/")) {
			const dirName = name.slice(0, -1);
			childrenDirs.push(
				create(LsDirectoryTreeNodeSchema, {
					absPath: `${rootPath.replace(/\/$/, "")}/${dirName}`,
					childrenDirs: [],
					childrenFiles: [],
					childrenWereProcessed: false,
					fullSubtreeExtensionCounts: {},
					numFiles: 0,
				}),
			);
		} else {
			childrenFiles.push(create(LsDirectoryTreeNode_FileSchema, { name }));
		}
	}

	const root = create(LsDirectoryTreeNodeSchema, {
		absPath: rootPath,
		childrenDirs,
		childrenFiles,
		childrenWereProcessed: true,
		fullSubtreeExtensionCounts: {},
		numFiles: childrenFiles.length,
	});

	return create(LsResultSchema, {
		result: {
			case: "success",
			value: create(LsSuccessSchema, { directoryTreeRoot: root }),
		},
	});
}

function buildLsErrorResult(path: string, error: string) {
	return create(LsResultSchema, {
		result: {
			case: "error",
			value: create(LsErrorSchema, { path, error }),
		},
	});
}

function buildLsRejectedResult(path: string, reason: string) {
	return create(LsResultSchema, {
		result: {
			case: "rejected",
			value: create(LsRejectedSchema, { path, reason }),
		},
	});
}

function buildGrepResultFromToolResult(
	args: { pattern: string; path?: string; outputMode?: string; offset?: number },
	toolResult: ToolResultMessage,
) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildGrepErrorResult(text || "Grep failed");
	}

	const outputMode = args.outputMode || "content";
	const clientTruncated = toolResultDetailBoolean(toolResult, "truncated");
	const lines = text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0 && !line.startsWith("[") && !line.toLowerCase().startsWith("no matches"));

	const workspaceKey = args.path || ".";
	let unionResult: GrepUnionResult;

	if (outputMode === "files_with_matches") {
		const files = lines;
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "files",
				value: create(GrepFilesResultSchema, {
					files,
					totalFiles: files.length,
					clientTruncated,
					ripgrepTruncated: false,
					// Echoes the offset this client actually applied; absent when
					// the frame requested none. The proto names the field but
					// nothing here pins the server's use of it, so it reports what
					// we did rather than asserting a pagination protocol.
					offsetApplied: args.offset,
				}),
			},
		});
	} else if (outputMode === "count") {
		const counts = lines
			.map((line) => {
				const separatorIndex = line.lastIndexOf(":");
				if (separatorIndex === -1) {
					return null;
				}
				const file = line.slice(0, separatorIndex);
				const count = Number.parseInt(line.slice(separatorIndex + 1), 10);
				if (!file || Number.isNaN(count)) {
					return null;
				}
				return create(GrepFileCountSchema, { file, count });
			})
			.filter((entry): entry is GrepFileCount => entry !== null);
		const totalMatches = counts.reduce((sum, entry) => sum + entry.count, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "count",
				value: create(GrepCountResultSchema, {
					counts,
					totalFiles: counts.length,
					totalMatches,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	} else {
		const matchMap = new Map<string, Array<{ line: number; content: string; isContextLine: boolean }>>();
		let totalMatchedLines = 0;

		for (const line of lines) {
			const matchLine = line.match(/^(.+?):(\d+):\s?(.*)$/);
			const contextLine = line.match(/^(.+?)-(\d+)-\s?(.*)$/);
			const match = matchLine ?? contextLine;
			if (!match) {
				continue;
			}
			const [, file, lineNumber, content] = match;
			const isContextLine = Boolean(contextLine);
			const list = matchMap.get(file) ?? [];
			list.push({ line: Number(lineNumber), content, isContextLine });
			matchMap.set(file, list);
			if (!isContextLine) {
				totalMatchedLines += 1;
			}
		}

		const matches = Array.from(matchMap.entries()).map(([file, matches]) =>
			create(GrepFileMatchSchema, {
				file,
				matches: matches.map((entry) =>
					create(GrepContentMatchSchema, {
						lineNumber: entry.line,
						content: entry.content,
						contentTruncated: false,
						isContextLine: entry.isContextLine,
					}),
				),
			}),
		);
		const totalLines = matches.reduce((sum, entry) => sum + entry.matches.length, 0);
		unionResult = create(GrepUnionResultSchema, {
			result: {
				case: "content",
				value: create(GrepContentResultSchema, {
					matches,
					totalLines,
					totalMatchedLines,
					clientTruncated,
					ripgrepTruncated: false,
					offsetApplied: args.offset,
				}),
			},
		});
	}

	return create(GrepResultSchema, {
		result: {
			case: "success",
			value: create(GrepSuccessSchema, {
				pattern: args.pattern,
				path: args.path || "",
				outputMode,
				workspaceResults: { [workspaceKey]: unionResult },
			}),
		},
	});
}

function buildGrepErrorResult(error: string) {
	return create(GrepResultSchema, {
		result: {
			case: "error",
			value: create(GrepErrorSchema, { error }),
		},
	});
}

/**
 * Reject a Cursor exec-channel `grepArgs` frame whose `pattern` is empty or
 * whitespace-only. Returns an actionable error message when the pattern is
 * unusable (with a `glob`-aware hint when the model likely meant to list
 * files), or `null` when the pattern is valid and grep should run.
 *
 * Exported for tests. Cursor's model sometimes sends `pattern=""` together
 * with a non-empty `glob`, expecting grep to enumerate matching files; the
 * downstream coding-agent `grep` tool rejects that with a bare "Pattern must
 * not be empty", which the TUI renders as `?` in the tool preview (issue
 * #4574). Handling it at the Cursor exec dispatch keeps the synthesized
 * `toolCall` block off the persisted assistant message and gives the model a
 * specific recovery hint.
 */
export function emptyGrepPatternRejection(pattern: string | undefined, glob: string | undefined): string | null {
	if (pattern && pattern.trim().length > 0) return null;
	if (glob && glob.length > 0) {
		return (
			`grep pattern is required (received an empty pattern). To list files matching "${glob}", ` +
			`pass a non-empty regex (e.g. ".") and set path to that glob, or use the ls/read tool instead.`
		);
	}
	return "grep pattern is required (received an empty pattern).";
}

function buildDiagnosticsResultFromToolResult(path: string, toolResult: ToolResultMessage) {
	const text = toolResultToText(toolResult);
	if (toolResult.isError) {
		return buildDiagnosticsErrorResult(path, text || "Diagnostics failed");
	}
	return create(DiagnosticsResultSchema, {
		result: {
			case: "success",
			value: create(DiagnosticsSuccessSchema, {
				path,
				diagnostics: [],
				totalDiagnostics: 0,
			}),
		},
	});
}

function buildDiagnosticsErrorResult(_path: string, error: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "error",
			value: create(DiagnosticsErrorSchema, { error }),
		},
	});
}

function buildDiagnosticsRejectedResult(path: string, reason: string) {
	return create(DiagnosticsResultSchema, {
		result: {
			case: "rejected",
			value: create(DiagnosticsRejectedSchema, { path, reason }),
		},
	});
}

function parseToolArgsJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return text;
	}
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return text;
	}
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const parsedValue = fromBinary(ValueSchema, value);
		const jsonValue = toJson(ValueSchema, parsedValue) as JsonValue;
		if (typeof jsonValue === "string") {
			return parseToolArgsJson(jsonValue);
		}
		return jsonValue;
	} catch {
		// Some protocol versions send plain JSON rather than protobuf Value bytes.
	}
	const text = new TextDecoder().decode(value);
	return parseToolArgsJson(text);
}

function decodeMcpArgsMap(args?: Record<string, Uint8Array>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decodeMcpArgValue(value);
	}
	return decoded;
}

function decodeMcpCall(args: {
	name: string;
	args: Record<string, Uint8Array>;
	toolCallId: string;
	providerIdentifier: string;
	toolName: string;
	smartModeApprovalOnly?: boolean;
}): CursorMcpCall {
	const decodedArgs: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args.args ?? {})) {
		decodedArgs[key] = decodeMcpArgValue(value);
	}
	return {
		name: args.name,
		providerIdentifier: args.providerIdentifier,
		toolName: args.toolName || args.name,
		toolCallId: args.toolCallId,
		args: decodedArgs,
		rawArgs: args.args ?? {},
		approvalOnly: args.smartModeApprovalOnly === true,
	};
}

/**
 * Map Cursor's `TodoStatus` enum (agent.proto) onto the local todo statuses.
 *
 * `TODO_STATUS_CANCELLED` (4) maps to `abandoned` rather than collapsing to
 * `pending`, which would resurrect a task the model explicitly cancelled.
 */
function mapTodoStatusValue(status?: number): CursorTodoSnapshotItem["status"] {
	switch (status) {
		case 2:
			return "in_progress";
		case 3:
			return "completed";
		case 4:
			return "abandoned";
		default:
			return "pending";
	}
}

interface CursorTodoItem {
	id?: string;
	content?: string;
	status?: number;
	/** IDs of other todos this one waits on (agent.proto `TodoItem.dependencies`). */
	dependencies?: string[];
}

interface CursorTodoResult {
	result?: {
		case?: "success" | "error";
		value?: { todos?: CursorTodoItem[]; totalCount?: number; wasMerge?: boolean; error?: string };
	};
}

interface CursorReadTodosArgs {
	statusFilter?: number[];
	idFilter?: string[];
}

interface CursorUpdateTodosCall {
	args?: { todos?: CursorTodoItem[]; merge?: boolean };
	result?: CursorTodoResult;
}

interface CursorReadTodosCall {
	args?: CursorReadTodosArgs;
	result?: CursorTodoResult;
}

/**
 * `ToolCall` is a protobuf oneof, so a decoded message exposes the selected
 * variant as `tool: { case, value }` — NOT as a named property. Hand-built
 * fixtures and some call sites still use the flattened form, so both are
 * accepted here.
 */
interface CursorTodoToolCall {
	tool?: { case?: string; value?: unknown };
	updateTodosToolCall?: CursorUpdateTodosCall;
	readTodosToolCall?: CursorReadTodosCall;
}

function selectTodoCalls(toolCall: CursorTodoToolCall): {
	update?: CursorUpdateTodosCall;
	read?: CursorReadTodosCall;
} {
	const oneof = toolCall.tool;
	if (oneof?.case === "updateTodosToolCall") return { update: oneof.value as CursorUpdateTodosCall };
	if (oneof?.case === "readTodosToolCall") return { read: oneof.value as CursorReadTodosCall };
	return { update: toolCall.updateTodosToolCall, read: toolCall.readTodosToolCall };
}

function mapTodoSnapshot(todos: CursorTodoItem[]): CursorTodoSnapshotItem[] {
	return todos.map((todo) => ({
		content: typeof todo.content === "string" ? todo.content : "",
		status: mapTodoStatusValue(typeof todo.status === "number" ? todo.status : undefined),
	}));
}

interface CursorMcpToolCall {
	args?: {
		name?: string;
		toolName?: string;
		toolCallId?: string;
		args?: Record<string, Uint8Array>;
	};
}

interface CursorMcpToolCallCarrier {
	tool?: { case?: string; value?: unknown };
	mcpToolCall?: CursorMcpToolCall;
}

/**
 * `ToolCall.tool` is a protobuf oneof: a wire-decoded message exposes the
 * variant as `{ case, value }` and NEVER as a flattened `mcpToolCall`
 * property. Reading the flat property alone is what made native todo calls
 * invisible on the wire while hand-shaped test fixtures kept passing, so MCP
 * goes through the same selector. The flat fallback is kept for those fixtures.
 */
function selectMcpCall(toolCall: CursorMcpToolCallCarrier | undefined): CursorMcpToolCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "mcpToolCall") return oneof.value as CursorMcpToolCall;
	return toolCall?.mcpToolCall;
}

/**
 * The streamed `ToolCall` variants whose block the exec channel owns.
 *
 * Each of these is announced on the interaction stream AND dispatched as its
 * own `ExecServerMessage` frame — the Pi family (45-51), plus the two MCP
 * resource frames — so the block is synthesized once, by the exec handler,
 * which is the side that has the result.
 *
 * `connect_scm` is deliberately NOT here: `ExecServerMessage` has no
 * connect-SCM case at all (field 44 is `git_diff_request`), so nothing on the
 * exec channel ever answers it and the streamed announcement is the only
 * signal. `search_conversations` is not here either: frame 53 answers it, but
 * it carries its own `tool_call_id` on the streamed envelope and pairs there,
 * so the exec branch does not synthesize a block for it.
 */
const EXEC_OWNED_TOOL_CALL_CASES: ReadonlySet<string> = new Set([
	"piReadToolCall",
	"piBashToolCall",
	"piEditToolCall",
	"piWriteToolCall",
	"piGrepToolCall",
	"piFindToolCall",
	"piLsToolCall",
	"listMcpResourcesToolCall",
	"readMcpResourceToolCall",
]);

function isExecOwnedToolCall(toolCall: { tool?: { case?: string } } | undefined): boolean {
	const variant = toolCall?.tool?.case;
	return variant !== undefined && EXEC_OWNED_TOOL_CALL_CASES.has(variant);
}

/**
 * Retain a freshly opened streamed tool-call block.
 *
 * Keyed by the interaction envelope's `call_id`, which is the only key every
 * `ToolCall*Update` for that call shares. The block's own `id` is deliberately
 * not the key: MCP, Pi and connect-SCM blocks are filed under the id carried
 * inside the call's `args`, because that is what the exec channel pairs its
 * result under and what the transcript files the visible block under.
 *
 * `currentToolCall` is still set, as the fallback for frames that carry no
 * `call_id` (proto3-optional, and unset on what older builds send).
 */
/**
 * Close every tool-call block still open when the stream ends.
 *
 * Not just the last one started: with interleaved calls several can be open at
 * once, and an unclosed block leaves its live card animating and its call
 * unpaired.
 *
 * Only blocks fed by a streamed argument buffer get reparsed. Todo,
 * connect-SCM and MCP-settled frames arrive with complete `arguments` and
 * never set the partial buffer; `parseStreamingJson(undefined)` returns `{}`,
 * so reparsing unconditionally would erase the arguments of every such block
 * caught open by a truncated stream.
 *
 * Server-owned blocks are also paired here. `connect-scm` and `todo` are
 * stamped {@link kCursorExecResolved} the moment they open, so `agent-loop.ts`
 * synthesizes no placeholder for them and only their `toolCallCompleted` frame
 * pairs a result. A transport that closes before that frame would leave the
 * call unpaired, and `buildSessionContext` strips a dangling call from every
 * rebuilt transcript — the interaction disappears. An interrupted result is
 * emitted instead.
 *
 * MCP blocks are excluded even when resolved: the exec dispatch that marked
 * them owns their result, and `drainInFlightDispatches` awaits it before this
 * runs, so pairing here would duplicate one against the same `toolCallId`.
 */
export function flushOpenToolCalls(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const openBlocks = new Set<ToolCallState>(state.openToolCalls.values());
	if (state.currentToolCall) openBlocks.add(state.currentToolCall);
	for (const block of openBlocks) {
		const idx = output.content.indexOf(block);
		const partialJson = block[kStreamingPartialJson];
		if (partialJson !== undefined) {
			block.arguments = parseStreamingJson(partialJson);
			clearStreamingPartialJson(block);
		}
		const kind = block[kStreamingBlockKind];
		if (kind === "connect-scm" || kind === "todo") {
			state.onToolResult?.({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: "The connection to Cursor closed before this call completed." }],
				isError: true,
				timestamp: Date.now(),
			});
		}
		stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
	}
	state.openToolCalls.clear();
	state.setToolCall(null);
}

function retainStreamedCall(state: BlockState, block: ToolCallState, envelopeId: string | undefined): void {
	if (envelopeId) state.openToolCalls.set(envelopeId, block);
	state.setToolCall(block);
}

/**
 * The open block a streamed update addresses, or `null` to ignore the update.
 *
 * Cursor interleaves calls: `start A, start B, complete A` is legal, so the
 * update must reach block A even though B opened last. An id naming no open
 * block is ignored rather than misapplied — settling the wrong block would pair
 * it with another call's result.
 *
 * A missing id falls back to the current block: the correlation key is
 * optional, and dropping those updates would strand a block stamped
 * {@link kCursorExecResolved}, which nothing else settles and whose whole
 * interaction is then stripped from every rebuilt transcript.
 */
function resolveStreamedCall(state: BlockState, envelopeId: string | undefined): ToolCallState | null {
	if (!envelopeId) return state.currentToolCall;
	const keyed = state.openToolCalls.get(envelopeId);
	if (keyed) return keyed;
	// Blocks opened before this build tracked envelope ids, and blocks opened
	// from a frame that carried none, are only reachable as `currentToolCall`.
	const current = state.currentToolCall;
	return current && current[kStreamingEnvelopeId] === undefined ? current : null;
}

/** Release a settled block from both the keyed map and the current slot. */
function releaseStreamedCall(state: BlockState, block: ToolCallState): void {
	const envelopeId = block[kStreamingEnvelopeId];
	if (envelopeId) state.openToolCalls.delete(envelopeId);
	if (state.currentToolCall === block) state.setToolCall(null);
}

interface CursorConnectScmRepository {
	owner?: string;
	repo?: string;
}

interface CursorConnectScmCall {
	args?: {
		toolCallId?: string;
		/** `ConnectScmArgs.target` oneof; `github` is its only member today. */
		target?: { case?: string; value?: { repository?: CursorConnectScmRepository } };
		github?: { repository?: CursorConnectScmRepository };
	};
	/** `ConnectScmResult.result` oneof: `success` | `error` | `rejected`. */
	result?: { result?: { case?: string; value?: { error?: string; reason?: string } } };
}

interface CursorConnectScmCarrier {
	tool?: { case?: string; value?: unknown };
	connectScmToolCall?: CursorConnectScmCall;
}

/**
 * The streamed `connect_scm_tool_call` variant, if this update carries one.
 *
 * Same oneof-vs-flattened handling as {@link selectMcpCall}: a wire-decoded
 * `ToolCall` exposes its variant as `{ case, value }`, while hand-shaped test
 * fixtures use the flat property.
 */
function selectConnectScmCall(toolCall: CursorConnectScmCarrier | undefined): CursorConnectScmCall | undefined {
	const oneof = toolCall?.tool;
	if (oneof?.case === "connectScmToolCall") return oneof.value as CursorConnectScmCall;
	return toolCall?.connectScmToolCall;
}

/** The repository a connect-SCM call targets, across the `target` oneof. */
function selectConnectScmRepository(call: CursorConnectScmCall | undefined): CursorConnectScmRepository | undefined {
	const target = call?.args?.target;
	if (target?.case === "github") return target.value?.repository;
	return call?.args?.github?.repository;
}

/**
 * Render a settled `ConnectScmResult` as the text of its paired tool result.
 *
 * Returns `isError` because the three outcomes are not interchangeable: only
 * `success` means the repository was connected, and reporting a rejection as
 * success would tell the model to proceed against a repo it cannot reach.
 */
function describeConnectScmResult(call: CursorConnectScmCall | undefined): { text: string; isError: boolean } {
	const result = call?.result?.result;
	switch (result?.case) {
		case "success":
			return { text: "SCM connected", isError: false };
		case "error":
			return { text: result.value?.error || "SCM connection failed", isError: true };
		case "rejected":
			return { text: result.value?.reason || "SCM connection rejected", isError: true };
		default:
			// A completion carrying no result settles the block anyway: it is
			// stamped resolved, so nothing downstream would ever pair it.
			return { text: "SCM connection reported no result", isError: true };
	}
}

/**
 * Extract the authoritative full todo list from a completed native todo call.
 *
 * Cursor owns this list server-side: `update_todos` / `read_todos` are resolved
 * remotely and the settled state rides on the tool call's `result`, never on
 * the exec channel (`ExecServerMessage` has no todo case). Only
 * `result.success.todos` is authoritative — the request `args` may differ from
 * what the server actually stored after a merge or normalization, and on
 * `UpdateTodosError` nothing was stored at all.
 *
 * A `read_todos` call carrying `status_filter` / `id_filter` (agent.proto
 * `ReadTodosArgs`) returns a SUBSET, not the list, and its `total_count`
 * reports the full size. Mirroring a partial response would delete every task
 * it omitted, so filtered and short reads are refused here. An empty read is
 * refused too: proto3 defaults unset `total_count` to 0, so `todos=[]` cannot
 * be told from a missing count.
 *
 * A snapshot whose rows are not unique by content is refused for a different
 * reason: Cursor keys todos by `id`, the local list is keyed by content, and
 * the collision is unrepresentable rather than merely partial.
 *
 * Returns `null` when no usable full snapshot is available, which the caller
 * MUST treat as "leave local state untouched".
 */
function extractTodoSnapshot(toolCall: CursorTodoToolCall): CursorTodoSnapshot | null {
	const { update, read } = selectTodoCalls(toolCall);
	if (read && ((read.args?.statusFilter?.length ?? 0) > 0 || (read.args?.idFilter?.length ?? 0) > 0)) {
		return null;
	}
	const call = update ?? read;
	if (!call) return null;
	const result = call.result?.result;
	if (result?.case !== "success") return null;
	const todos = result.value?.todos;
	if (!todos) return null;
	// A response that disagrees with the server's own count is partial; treating
	// it as the list would drop whatever it left out. This applies to BOTH call
	// kinds and to the empty case: a size-limited or partial `update_todos`
	// merge response is just as incomplete as a filtered read, and an empty one
	// whose `total_count` is nonzero is the most destructive shape of all —
	// mirroring it would delete every local task at once.
	//
	// `total_count` is a proto3 scalar, so an unset field arrives as `0`. That
	// makes `todos=[]` + `total_count=0` ambiguous: a genuine clear, or a
	// filtered read that matched nothing with the count omitted. An empty READ
	// is therefore refused outright, while an empty UPDATE with a matching zero
	// count remains the authoritative clear path.
	const totalCount = result.value?.totalCount;
	if (typeof totalCount === "number" && totalCount !== todos.length) {
		return null;
	}
	if (read && todos.length === 0) {
		return null;
	}
	const mapped = mapTodoSnapshot(todos);
	// A row whose `content` is missing or proto-default lands as `""`. The local
	// list is keyed by content and `resolveTaskOrError` rejects a falsy one
	// before lookup, so the task would be permanently unreachable to every
	// task-targeted `done`/`drop`/`rm` — the same unrepresentable shape as a
	// content collision, refused for the same reason.
	if (mapped.some((todo) => todo.content.length === 0)) return null;
	// The wire model identifies rows by `id` and can represent two rows sharing
	// `content`; the local list is keyed by content alone (`findTaskByContent`)
	// and `todo` rejects a duplicate outright. Importing such a snapshot would
	// leave every task-targeted `done`/`drop`/`rm` resolving to the first row and
	// the second unreachable (phase-wide and untargeted ops still hit both), so
	// it is refused like any other snapshot that cannot be represented locally.
	const seen = new Set<string>();
	for (const todo of mapped) {
		if (seen.has(todo.content)) return null;
		seen.add(todo.content);
	}
	// `TodoItem.dependencies` carries the IDs a row waits on. The local model can
	// express *that* a task is blocked (`TodoStatus` has `blocked`, `TodoItem`
	// has `blocker`), but not the graph: it has no ids, so an edge cannot be
	// stored, replayed, or re-evaluated when the blocker later completes.
	//
	// Dropping the edge silently is the harmful part. `nextActionableTask`
	// (`todo.ts:164`) returns the first `pending` row with no notion of
	// blockage, so the panel, the idle recap, and the completion reminders
	// would all steer toward work the server says is not ready yet — and a
	// reload loses the constraint for good.
	//
	// Only *unresolved* edges are refused: a dependency on an already
	// finished row imposes nothing, which keeps late-session snapshots
	// syncing normally.
	//
	// Projecting unresolved edges onto `blocked` + a `blocker` note is the
	// lossy alternative — it preserves the warning but not the graph, and
	// nothing would ever unblock the row, since the local engine has no id to
	// match when the dependency completes. Refusing keeps this consistent with
	// the collision case above: decline what cannot be represented rather than
	// import an approximation.
	const finished = new Set<string>();
	for (const todo of todos) {
		const status = mapTodoStatusValue(typeof todo.status === "number" ? todo.status : undefined);
		if (todo.id && (status === "completed" || status === "abandoned")) finished.add(todo.id);
	}
	for (const todo of todos) {
		for (const dependency of todo.dependencies ?? []) {
			if (!finished.has(dependency)) return null;
		}
	}
	return {
		todos: mapped,
		// Presentation-only: the snapshot is already the settled full list.
		merged: result.value?.wasMerge === true,
	};
}

/**
 * Error text when the server itself rejected the call.
 *
 * Distinct from {@link extractTodoSnapshot} returning `null`: a filtered read, a
 * truncated or empty one (proto3 cannot tell unset `total_count` from zero), or
 * a snapshot the local model cannot represent are all benign refusals (the call
 * succeeded, we just decline to mirror it), whereas an `UpdateTodosError` /
 * `ReadTodosError` is a real failure that must not replay as a successful no-op.
 */
function extractTodoError(toolCall: CursorTodoToolCall): string | null {
	const { update, read } = selectTodoCalls(toolCall);
	const result = (update ?? read)?.result?.result;
	if (result?.case !== "error") return null;
	const error = result.value?.error;
	return typeof error === "string" && error.length > 0 ? error : "Todo operation failed";
}

/** Args echoed onto the synthesized display block, for rendering only. */
function buildTodoDisplayArgs(toolCall: CursorTodoToolCall): { todos: CursorTodoSnapshotItem[]; merge?: boolean } {
	const args = selectTodoCalls(toolCall).update?.args;
	return {
		todos: args?.todos ? mapTodoSnapshot(args.todos) : [],
		merge: args?.merge === true ? true : undefined,
	};
}

/**
 * Paired result for a server-resolved native todo call.
 *
 * The bridge never runs a local `todo` tool for these, so nothing else would
 * produce a `toolResult` for the block — and `buildSessionContext` strips any
 * `toolCall` left unpaired, taking the interaction out of every rebuilt
 * transcript.
 *
 * Three outcomes, kept distinct: a server error replays as a failure, a benign
 * refusal (a filtered, truncated, or empty read, or a snapshot the local model
 * cannot represent) replays as `"Todo snapshot not mirrored"`, and a settled
 * snapshot replays as its summary. Collapsing the first into the second would
 * hide the failure and let downstream lifecycle logic treat it as success. The
 * refusal text must not say `"No todo changes"`: an `update_todos` the server
 * accepted may still be declined locally, and that is not "no changes".
 */
function buildTodoToolResult(
	toolCallId: string,
	snapshot: CursorTodoSnapshot | null,
	error: string | null,
): ToolResultMessage {
	const text = error ?? (snapshot ? formatTodoSnapshotSummary(snapshot.todos) : "Todo snapshot not mirrored");
	return {
		role: "toolResult",
		toolCallId,
		toolName: "todo",
		content: [{ type: "text", text }],
		isError: error !== null,
		timestamp: Date.now(),
	};
}

function formatTodoSnapshotSummary(todos: CursorTodoSnapshotItem[]): string {
	if (todos.length === 0) return "No todos";
	const done = todos.filter((todo) => todo.status === "completed").length;
	return `${done}/${todos.length} tasks completed`;
}

function buildMcpResultFromToolResult(_mcpCall: CursorMcpCall, toolResult: ToolResultMessage) {
	if (toolResult.isError) {
		return buildMcpErrorResult(toolResultToText(toolResult) || "MCP tool failed");
	}
	const content = toolResult.content.map((item) => {
		if (item.type === "image") {
			return create(McpToolResultContentItemSchema, {
				content: {
					case: "image",
					value: create(McpImageContentSchema, {
						data: Uint8Array.from(Buffer.from(item.data, "base64")),
						mimeType: item.mimeType,
					}),
				},
			});
		}
		return create(McpToolResultContentItemSchema, {
			content: {
				case: "text",
				value: create(McpTextContentSchema, { text: item.text }),
			},
		});
	});

	return create(McpResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content,
				isError: false,
			}),
		},
	});
}

function buildMcpToolNotFoundResult(mcpCall: CursorMcpCall) {
	return create(McpResultSchema, {
		result: {
			case: "toolNotFound",
			value: create(McpToolNotFoundSchema, { name: mcpCall.toolName, availableTools: [] }),
		},
	});
}

function buildMcpErrorResult(error: string) {
	return create(McpResultSchema, {
		result: {
			case: "error",
			value: create(McpErrorSchema, { error }),
		},
	});
}

/**
 * Merge the decoded completion-frame `McpArgs` map into the args assembled
 * from streamed `args_text_delta` snapshots.
 *
 * The completion frame is authoritative for the scalars it carries — but it
 * can omit oversized parameters entirely and can downgrade a structured value
 * to its raw string fallback when `decodeMcpArgValue` cannot parse it as
 * JSON. Overwriting the streamed args wholesale therefore loses data (e.g.
 * the task tool's `tasks` array on multi-subagent dispatches, issue #2615).
 *
 * Rules per key:
 * - completion key absent  → keep the streamed value.
 * - completion is a string while the streamed value is structured (object or
 *   array) → keep the streamed value (the completion frame downgraded it).
 * - otherwise               → completion wins.
 */
export function mergeCursorMcpToolCallArgs(
	streamed: Record<string, unknown> | undefined,
	completion: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(streamed ?? {}) };
	if (!completion) return merged;
	for (const [key, completionValue] of Object.entries(completion)) {
		const streamedValue = merged[key];
		if (typeof completionValue === "string" && streamedValue !== null && typeof streamedValue === "object") {
			continue;
		}
		merged[key] = completionValue;
	}
	return merged;
}

function endCurrentTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream, state: BlockState): void {
	const block = state.currentTextBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "text_end",
		contentIndex: idx,
		content: block.text,
		partial: output,
	});
	state.setTextBlock(null);
}

function endCurrentThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const block = state.currentThinkingBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: block.thinking,
		partial: output,
	});
	state.setThinkingBlock(null);
}

/**
 * Synthesize a completed `toolCall` content block for a Cursor exec-channel
 * native tool (`shell`, `read`, `write`, `grep`, `ls`, `delete`, `diagnostics`)
 * or for an MCP exec frame whose corresponding interaction block is absent.
 *
 * Args arrive complete on the exec message, so the block opens and closes in
 * one step — no partial-JSON streaming path. Without this the persisted
 * assistant message carries only text/thinking blocks, and on replay the
 * following `toolResult` messages have no matching `toolCall.id` in
 * `renderSessionContext`, so they render beneath the final answer or disappear.
 *
 * The block is stamped with {@link kCursorExecResolved} so the shared
 * `agent-loop.ts` execution pass skips it — Cursor's server-driven exec
 * channel already ran the tool via the bridge and buffered the result, so
 * treating this block as runnable would re-execute the same side-effecting
 * tool a second time.
 *
 * Exported for tests to exercise ordering with adjacent text/thinking blocks.
 */
export function synthesizeCursorExecToolCall(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
): void {
	endCurrentTextBlock(output, stream, state);
	endCurrentThinkingBlock(output, stream, state);
	const block: ToolCallState = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: args,
		[kStreamingBlockIndex]: output.content.length,
		[kStreamingBlockKind]: "cursor-exec",
		[kCursorExecResolved]: true,
	};
	output.content.push(block);
	const idx = output.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
}

/**
 * Pair a `toolResult` for a synthesized block the client answered itself,
 * without ever consulting a handler.
 *
 * {@link resolveExecHandler} does this for every frame backed by a local tool.
 * Frames answered from a fixed verdict — no handler, no local execution — still
 * need the pair for the same reason: the block was stamped
 * {@link kCursorExecResolved}, so `agent-loop.ts` emits no placeholder for it
 * and `buildSessionContext` strips an unpaired call, taking the whole
 * interaction out of every rebuilt transcript.
 *
 * `isError` defaults true because most such verdicts are refusals; the MCP
 * resource frames run locally and can genuinely succeed, and a success filed
 * as an error would render as a failed call in every rebuilt transcript.
 */
async function pairSynthesizedExecResult(
	state: BlockState,
	onToolResult: CursorToolResultHandler | undefined,
	toolCallId: string,
	toolName: string,
	text: string,
	isError = true,
): Promise<void> {
	const synthesized: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
	const sink = onToolResult ?? state.onToolResult;
	if (!sink) return;
	await sink(synthesized);
}

/** Exported for tests: drives one Cursor interaction update through the streaming state machine. */
export function processInteractionUpdate(
	update: any,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	usageState: UsageState,
): void {
	const updateCase = update.message?.case;

	log("interactionUpdate", updateCase, update.message?.value);

	if (updateCase === "textDelta") {
		state.setFirstTokenTime();
		const delta = update.message.value.text || "";
		if (!state.currentTextBlock) {
			const block: TextContent & { [kStreamingBlockIndex]: number } = {
				type: "text",
				text: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentTextBlock!.text += delta;
		const idx = output.content.indexOf(state.currentTextBlock!);
		stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingDelta") {
		state.setFirstTokenTime();
		const delta = update.message.value.text || "";
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { [kStreamingBlockIndex]: number } = {
				type: "thinking",
				thinking: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentThinkingBlock!.thinking += delta;
		const idx = output.content.indexOf(state.currentThinkingBlock!);
		stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingCompleted") {
		endCurrentThinkingBlock(output, stream, state);
	} else if (updateCase === "toolCallStarted" && selectConnectScmCall(update.message.value.toolCall)) {
		// `connect_scm` is resolved entirely server-side and has NO exec frame:
		// `ExecServerMessage` carries no connect-SCM case (field 44 is
		// `git_diff_request`), so the streamed pair is the only signal this client
		// sees. The authoritative outcome rides on the COMPLETION's `result`
		// oneof, so the block is opened here and settled there — answering now
		// would persist a verdict before the server has given one.
		//
		// Stamped resolved so `agent-loop.ts` runs no local tool for it: there is
		// no local `connect_scm`, and the completion pairs the result itself.
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const scmCall = selectConnectScmCall(update.message.value.toolCall);
		const repository = selectConnectScmRepository(scmCall);
		const block: ToolCallState = {
			type: "toolCall",
			id: scmCall?.args?.toolCallId || update.message.value.callId || crypto.randomUUID(),
			name: "connect_scm",
			arguments: repository ? { owner: repository.owner, repo: repository.repo } : {},
			[kStreamingBlockIndex]: output.content.length,
			[kStreamingBlockKind]: "connect-scm",
			[kStreamingEnvelopeId]: update.message.value.callId || undefined,
			[kCursorExecResolved]: true,
		};
		output.content.push(block);
		retainStreamedCall(state, block, update.message.value.callId);
		stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
	} else if (updateCase === "toolCallStarted" && isExecOwnedToolCall(update.message.value.toolCall)) {
		// The exec channel already synthesized this block (and marked it resolved)
		// when it ran the tool locally, so the streamed announcement must not
		// create a second one. Modern builds stream a `pi_*_tool_call` envelope
		// alongside every `ExecServerMessage` 45-51 frame; before this branch the
		// duplicate was avoided only because the decoder recognised neither, which
		// would silently start double-rendering the moment a variant was added.
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		log("exec", "streamedToolCallOwnedByExec", { case: update.message.value.toolCall?.tool?.case });
	} else if (updateCase === "toolCallStarted") {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const toolCall = update.message.value.toolCall;
		if (toolCall) {
			const mcpCall = selectMcpCall(toolCall);
			if (mcpCall) {
				const args = mcpCall.args || {};
				const id = args.toolCallId || crypto.randomUUID();
				const resolvedByExec = state.resolvedMcpToolCallIds.delete(id);
				if (resolvedByExec && output.content.some((block) => block.type === "toolCall" && block.id === id)) {
					return;
				}
				const block: ToolCallState = {
					type: "toolCall",
					id,
					// Same precedence as `decodeMcpCall` (`toolName || name`), which is
					// what the exec channel pairs its result under. Diverging here would
					// name the block one thing and its result another.
					name: args.toolName || args.name || "",
					arguments: {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingPartialJson]: "",
					[kStreamingBlockKind]: "mcp",
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
				};
				if (resolvedByExec) {
					markCursorExecResolved(block);
				}
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}

			// Cursor resolves `update_todos` / `read_todos` server-side and settles
			// them on the tool call's `result`. Both blocks are stamped resolved so
			// `agent-loop.ts` never runs them locally: there is no local tool behind
			// them, and executing one would emit a spurious toolResult and drive an
			// extra continuation turn. Local state is mirrored on completion, from
			// the server's success snapshot only.
			const todoCalls = selectTodoCalls(toolCall);
			if (todoCalls.update || todoCalls.read) {
				const callId = update.message.value.callId || crypto.randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id: callId,
					name: "todo",
					arguments: buildTodoDisplayArgs(toolCall),
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingBlockKind]: "todo",
					// Only the real envelope id is a correlation key; the minted
					// fallback below names no frame the server will ever send back.
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
					[kCursorExecResolved]: true,
				};
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}
		}
	} else if (updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
		// Same correlation rule as the completion path below: an argument delta
		// belonging to a different call must not be appended to this block's
		// buffer, which would corrupt the JSON both of them parse.
		const target = resolveStreamedCall(state, update.message.value.callId);
		if (target?.[kStreamingBlockKind] === "mcp") {
			// Cursor's `args_text_delta` is "aggregated args text so far" per agent.proto: each
			// delta is a cumulative snapshot of the JSON-text args. Strip the prefix we already
			// have to recover the new suffix; fall back to treating the value as an incremental
			// fragment when it doesn't extend the buffer.
			const snapshot: string = update.message.value.argsTextDelta || "";
			const current = target[kStreamingPartialJson] ?? "";
			const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
			if (chunk.length === 0) {
				return;
			}
			const nextBuffer = current + chunk;
			target[kStreamingPartialJson] = nextBuffer;
			// Throttle mid-stream parses to keep total parse work O(N) instead of O(N²)
			// in the argument-buffer length; the authoritative full parse runs in
			// `toolCallCompleted` (mcp branch) and the fallback end-of-stream path.
			const throttled = parseStreamingJsonThrottled(nextBuffer, target[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				target.arguments = throttled.value;
				target[kStreamingLastParseLen] = throttled.parsedLen;
			}
			const idx = output.content.indexOf(target);
			stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: output });
		}
	} else if (updateCase === "toolCallCompleted") {
		// Correlate on the envelope's `call_id`, NOT the block id: MCP, Pi and SCM
		// blocks are filed under the id inside the call's `args` (which is what
		// the exec channel pairs its result under), and that need not equal the
		// envelope id. Cursor also interleaves calls, so the block this settles
		// is looked up by id rather than assumed to be the last one opened —
		// otherwise an unrelated completion closes whichever block is current and
		// pairs it with the wrong result.
		const settled = resolveStreamedCall(state, update.message.value.callId);
		if (settled) {
			const toolCall = update.message.value.toolCall;
			if (settled[kStreamingBlockKind] === "mcp") {
				// Authoritative full parse of the accumulated argument buffer; the delta
				// path throttles mid-stream parses, so `arguments` may lag the buffer.
				const partial = settled[kStreamingPartialJson];
				if (partial !== undefined) {
					settled.arguments = parseStreamingJson(partial);
				}
				const decodedArgs = decodeMcpArgsMap(selectMcpCall(toolCall)?.args?.args);
				settled.arguments = mergeCursorMcpToolCallArgs(
					settled.arguments as Record<string, unknown> | undefined,
					decodedArgs,
				);
			} else if (settled[kStreamingBlockKind] === "connect-scm") {
				// The authoritative outcome arrives only here, on the completion's
				// `ConnectScmResult` oneof. The block was stamped resolved at start,
				// so nothing downstream pairs it: settling is this branch's job, and
				// a completion with no `toolCall` still settles rather than leaking a
				// dangling call into every rebuilt transcript.
				//
				// Late args are merged too — a start frame may announce the call
				// before the target repository is known.
				const scmCall = selectConnectScmCall(toolCall);
				const repository = selectConnectScmRepository(scmCall);
				if (repository) {
					settled.arguments = { owner: repository.owner, repo: repository.repo };
				}
				const { text, isError } = describeConnectScmResult(scmCall);
				state.onToolResult?.({
					role: "toolResult",
					toolCallId: settled.id,
					toolName: "connect_scm",
					content: [{ type: "text", text }],
					isError,
					timestamp: Date.now(),
				});
			} else if (settled[kStreamingBlockKind] === "todo") {
				// Only the server's success snapshot is authoritative: the request args
				// may differ from what was actually stored after a merge, and on
				// `UpdateTodosError` nothing was stored at all. No snapshot => leave
				// both the rendered args and local session state untouched.
				//
				// A completion frame whose optional `toolCall` is absent carries
				// neither, but must still settle: the block is already marked
				// `kCursorExecResolved`, so `agent-loop.ts` emits no placeholder for
				// it and an unpaired call is stripped from every rebuilt transcript.
				// It reads as "nothing to mirror", the same as a refused snapshot.
				const snapshot = toolCall ? extractTodoSnapshot(toolCall) : null;
				const error = toolCall ? extractTodoError(toolCall) : null;
				if (snapshot) {
					settled.arguments = { todos: snapshot.todos, merged: snapshot.merged };
				}
				// The host settles EVERY completed native todo call, successful or
				// not: the interactive card only resolves on a matching
				// `tool_execution_end`, so staying silent on a refusal or a server
				// error would leave it animating for the rest of the session. The
				// streamed call id is reused because the transcript filed the block
				// under it.
				//
				// Exactly one result is persisted. The host's is preferred — only it
				// carries the `details.phases` the todo renderer replays the list
				// from — with the provider's summary standing in when the host has
				// nothing to add.
				let persisted: ToolResultMessage | undefined;
				let hostError: string | null = null;
				try {
					persisted = state.onTodoSnapshot?.(snapshot, settled.id, error) ?? undefined;
				} catch (callbackError) {
					// A throwing host callback (e.g. session persistence failing on
					// disk error) must not leave the resolved block unpaired: the
					// exception would skip both the paired result and `toolcall_end`,
					// stranding the live card and stripping the call from every
					// rebuilt transcript. Settle it as a failure instead.
					hostError = callbackError instanceof Error ? callbackError.message : String(callbackError);
					log("error", "onTodoSnapshot", { error: hostError });
				}
				state.onToolResult?.(persisted ?? buildTodoToolResult(settled.id, snapshot, hostError ?? error));
			}
			const idx = output.content.indexOf(settled);
			clearStreamingPartialJson(settled);
			stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: settled, partial: output });
			releaseStreamedCall(state, settled);
		}
	} else if (updateCase === "turnEnded") {
		output.stopReason = "stop";
		const terminal = update.message.value;
		const safeCount = (value: bigint | undefined): number => {
			const count = Number(value ?? 0n);
			return Number.isSafeInteger(count) && count >= 0 ? count : 0;
		};
		output.usage.input = safeCount(terminal.inputTokens);
		output.usage.output = safeCount(terminal.outputTokens);
		output.usage.cacheRead = safeCount(terminal.cacheReadTokens);
		output.usage.cacheWrite = safeCount(terminal.cacheWriteTokens);
		// Cursor reports reasoning as an informational subset of output, so do not
		// add it again. Cache writes are an independent usage component.
		output.usage.reasoning = safeCount(terminal.reasoningTokens);
		output.usage.totalTokens =
			output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		usageState.sawTerminalUsage = true;
	} else if (updateCase === "tokenDelta") {
		const tokenDelta = update.message.value;
		usageState.sawTokenDelta = true;
		if (!usageState.sawTerminalUsage) output.usage.output += tokenDelta.tokens || 0;
		output.usage.totalTokens =
			output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	}
}

export function handleConversationCheckpointUpdate(
	checkpoint: ConversationStateStructure,
	output: AssistantMessage,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): void {
	onConversationCheckpoint?.(checkpoint);
	const usedTokens = checkpoint.tokenDetails?.usedTokens ?? 0;
	const maxTokens = checkpoint.tokenDetails?.maxTokens ?? 0;
	if (usedTokens > 0) output.usage.contextTokens = usedTokens;
	if (maxTokens > 0) output.usage.contextMaxTokens = maxTokens;
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
	const blobId = createBlobId(data);
	blobStore.set(Buffer.from(blobId).toString("hex"), data);
	return blobId;
}

function readCursorBlob(blobStore: Map<string, Uint8Array>, blobId: Uint8Array): Uint8Array {
	const data = blobStore.get(Buffer.from(blobId).toString("hex"));
	if (!data) {
		throw new AIError.ValidationError("Cursor blob not found");
	}
	return data;
}

/**
 * Local tools Cursor already drives natively over the exec channel, so
 * advertising them again as MCP tools would give the model two ways to call the
 * same thing.
 *
 * `lsp` is deliberately NOT here. The native `diagnosticsArgs` frame covers
 * exactly one of the tool's actions (`action: "diagnostics"`); the rest —
 * `definition`, `references`, `rename`, `code_actions`, `hover`,
 * `implementation`, `type_definition`, `symbols`, ... — have no native frame at
 * all, so filtering the whole tool out hid every one of them from the model.
 */
const CURSOR_NATIVE_TOOL_NAMES = new Set(["bash", "read", "write", "delete", "ls", "grep", "todo"]);

export function buildMcpToolDefinitions(tools: Tool[] | undefined): McpToolDefinition[] {
	if (!tools || tools.length === 0) {
		return [];
	}

	const advertisedTools = tools.filter((tool) => !CURSOR_NATIVE_TOOL_NAMES.has(tool.name));
	if (advertisedTools.length === 0) {
		return [];
	}

	// Native write remains exclusively on the exec channel; do not advertise a duplicate MCP path.

	return advertisedTools.map((tool) => {
		const jsonSchema = toolWireSchema(tool);
		const schemaValue: JsonValue =
			jsonSchema && typeof jsonSchema === "object"
				? (jsonSchema as JsonValue)
				: { type: "object", properties: {}, required: [] };
		const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue));
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi-agent",
			toolName: tool.name,
			inputSchema,
		});
	});
}

/**
 * Extract text content from a user or developer message.
 */
function extractUserMessageText(msg: Message): string {
	if (msg.role !== "user") return "";
	const content = msg.content;
	if (typeof content === "string") return content.trim();
	const text = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return text.trim();
}

function hasUserMessageImages(msg: Message): boolean {
	return msg.role === "user" && Array.isArray(msg.content) && msg.content.some((item) => item.type === "image");
}

type CursorRootPromptContentPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

function buildCursorRootPromptContent(content: string | (TextContent | ImageContent)[]): CursorRootPromptContentPart[] {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}
	const parts: CursorRootPromptContentPart[] = [];
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.trim();
			if (text) {
				parts.push({ type: "text", text });
			}
		} else {
			parts.push({ type: "image", image: `data:${item.mimeType};base64,${item.data}`, mediaType: item.mimeType });
		}
	}
	return parts;
}

function cursorUserContentKey(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const hash = createHash("sha256");
	for (const item of content) {
		hash.update(item.type);
		if (item.type === "text") {
			hash.update(item.text);
		} else {
			hash.update(item.mimeType);
			hash.update(item.data);
		}
	}
	return hash.digest("hex");
}

type CursorRootPromptAssistantContentPart =
	| { type: "text"; text: string }
	| {
			type: "reasoning";
			text: string;
			providerOptions: { cursor: { modelName: string } };
			signature?: string;
	  }
	| { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> };

function canReplayCursorThinking(msg: AssistantMessage, targetModelId: string | undefined): boolean {
	return (
		targetModelId !== undefined &&
		isCursorGrok45RouteId(targetModelId) &&
		msg.api === "cursor-not-cloud" &&
		msg.provider === "cursor-not-cloud" &&
		// Route-aware: a turn persisted under any Grok 4.5 route id (low/medium/high/fast)
		// replays against any other route of the same logical model.
		canonicalCursorGrok45ModelId(msg.model) === canonicalCursorGrok45ModelId(targetModelId)
	);
}

function buildCursorAssistantContent(
	msg: AssistantMessage,
	targetModelId: string | undefined,
): CursorRootPromptAssistantContentPart[] {
	const content: CursorRootPromptAssistantContentPart[] = [];
	const replayThinking = canReplayCursorThinking(msg, targetModelId);
	for (const item of msg.content) {
		if (item.type === "text") {
			if (item.text) content.push({ type: "text", text: item.text });
		} else if (item.type === "thinking") {
			if (replayThinking && item.thinking) {
				content.push({
					type: "reasoning",
					text: item.thinking,
					providerOptions: { cursor: { modelName: msg.model } },
					...(item.thinkingSignature ? { signature: item.thinkingSignature } : {}),
				});
			}
		} else if (item.type === "toolCall") {
			content.push({
				type: "tool-call",
				toolCallId: item.id,
				toolName: item.name,
				args: item.arguments,
			});
		}
	}
	return content;
}

function assertCursorGrok45HistoryReplayable(
	messages: Message[],
	activeUserMessageIndex: number,
	targetModelId: string | undefined,
): void {
	if (!targetModelId || !isCursorGrok45RouteId(targetModelId)) return;
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const missingThinkingTurns: number[] = [];
	const newlyWarnedKeys: string[] = [];
	let assistantTurn = 0;
	for (let i = 0; i < historyEnd; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		assistantTurn++;
		const isSameCursorModel =
			msg.api === "cursor-not-cloud" &&
			msg.provider === "cursor-not-cloud" &&
			canonicalCursorGrok45ModelId(msg.model) === canonicalCursorGrok45ModelId(targetModelId);
		if (!isSameCursorModel) {
			// Foreign history cannot replay Grok reasoning: another model's
			// turns carry no compatible signed reasoning to reconstruct.
			throw new AIError.ValidationError(
				`Cursor ${targetModelId} cannot continue history from a different model (${msg.provider}/${msg.model}); start a new session.`,
			);
		}
		const hasThinking = msg.content.some((item) => item.type === "thinking" && item.thinking.length > 0);
		if (hasThinking) continue;
		const warningKey = `${msg.api}\0${msg.provider}\0${msg.model}\0${msg.timestamp}`;
		if (cursorConversationStateStore.hasWarning(warningKey)) continue;
		missingThinkingTurns.push(assistantTurn);
		newlyWarnedKeys.push(warningKey);
	}
	if (missingThinkingTurns.length === 0) return;
	for (const key of newlyWarnedKeys) cursorConversationStateStore.markWarning(key);
	logger.warn(
		`Cursor Grok 4.5 history contains same-model assistant turn(s) ${missingThinkingTurns.join(", ")} without thinking blocks; replaying those spans without reasoning may make generation less stable`,
		{ model: targetModelId, assistantTurns: missingThinkingTurns },
	);
}

/**
 * Index of the last user/developer message in `messages`, or -1 if none.
 * Used to exclude the current user turn from history builders — it goes in
 * `ConversationActionSchema.userMessageAction`, not in history structures.
 */
function findLastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "user") {
			return i;
		}
	}
	return -1;
}

/**
 * Build `ConversationStateStructure.rootPromptMessagesJson` blob IDs for the
 * system prompt plus prior conversation history, as JSON blobs matching
 * Cursor's internal Vercel-AI-SDK-shaped message format.
 *
 * Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build the
 * actual model prompt. `turns[]` is UI/display metadata. Without populating
 * this field, multi-turn conversations lose prior context — the model sees
 * only an empty placeholder where historical user turns should be.
 * The active user message is excluded because it is sent in the action.
 */
/**
 * Build one Cursor system-message JSON blob per ordered system prompt. Emitting separate blobs
 * (rather than a single `\n\n`-joined string) lets Cursor's blob cache hit independently per
 * entry: changing only the last prompt does not invalidate earlier blob ids, so the prefix
 * up to the changed prompt remains cached on the server side.
 *
 * When no system prompts are provided, returns a single default greeting so we never emit
 * an empty `rootPromptMessagesJson` head.
 */
export function buildCursorSystemPromptJsons(systemPrompt: string | readonly string[] | undefined): string[] {
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length === 0) {
		return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
	}
	return systemPrompts.map((content) => JSON.stringify({ role: "system", content }));
}

function buildRootPromptMessagesJson(
	messages: Message[],
	systemPromptIds: Uint8Array[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): Uint8Array[] {
	assertCursorGrok45HistoryReplayable(messages, activeUserMessageIndex, targetModelId);
	const entries: Uint8Array[] = [...systemPromptIds];
	const pushJson = (obj: unknown) => {
		const bytes = new TextEncoder().encode(JSON.stringify(obj));
		entries.push(storeCursorBlob(blobStore, bytes));
	};

	for (let i = 0; i < messages.length; i++) {
		if (i === activeUserMessageIndex) break;
		const msg = messages[i];
		if (msg.role === "user") {
			const content = buildCursorRootPromptContent(msg.content);
			if (content.length === 0) continue;
			pushJson({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content = buildCursorAssistantContent(msg, targetModelId);
			if (content.length === 0) continue;
			pushJson({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			// Emit even when the result text is empty: the assistant `tool-call` is
			// already in history, so dropping the pair would replay an orphaned call.
			pushJson({
				role: "tool",
				id: msg.toolCallId,
				content: [
					{
						type: "tool-result",
						toolName: msg.toolName,
						toolCallId: msg.toolCallId,
						result: toolResultToText(msg),
						...(msg.isError ? { isError: true } : {}),
					},
				],
			});
		}
	}

	return entries;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isPlainRecord(value)) return false;
	for (const key in value) {
		if (!isJsonValue(value[key])) return false;
	}
	return true;
}

function encodeCursorMcpArguments(toolCall: ToolCall): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const name in toolCall.arguments) {
		const value = toolCall.arguments[name];
		if (value === undefined) continue;
		if (!isJsonValue(value)) {
			throw new AIError.ValidationError(`Cursor tool argument ${toolCall.name}.${name} is not JSON-serializable`);
		}
		encoded[name] = toBinary(ValueSchema, fromJson(ValueSchema, value));
	}
	return encoded;
}

function createCursorMcpResult(result: ToolResultMessage) {
	if (result.isError) {
		return create(McpToolResultSchema, {
			result: {
				case: "error",
				value: create(McpToolErrorSchema, { error: toolResultToText(result) }),
			},
		});
	}
	return create(McpToolResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content: result.content.map((item) =>
					item.type === "text"
						? create(McpToolResultContentItemSchema, {
								content: { case: "text", value: create(McpTextContentSchema, { text: item.text }) },
							})
						: create(McpToolResultContentItemSchema, {
								content: {
									case: "image",
									value: create(McpImageContentSchema, {
										data: Uint8Array.from(Buffer.from(item.data, "base64")),
										mimeType: item.mimeType,
									}),
								},
							}),
				),
			}),
		},
	});
}

function createCursorToolCallStep(toolCall: ToolCall, result: ToolResultMessage | undefined) {
	const mcpCall = create(McpToolCallSchema, {
		args: create(McpArgsSchema, {
			name: toolCall.name,
			args: encodeCursorMcpArguments(toolCall),
			toolCallId: toolCall.id,
			providerIdentifier: "pi-agent",
			toolName: toolCall.name,
		}),
		...(result ? { result: createCursorMcpResult(result) } : {}),
	});
	return create(ConversationStepSchema, {
		message: {
			case: "toolCall",
			value: create(ToolCallSchema, {
				tool: { case: "mcpToolCall", value: mcpCall },
				toolCallId: toolCall.id,
			}),
		},
	});
}

/**
 * Convert context.messages to Cursor's ConversationTurnStructure blob IDs.
 * Groups messages into turns: each turn is a user message followed by the assistant's response.
 * Excludes the active user message (which goes in the action).
 *
 * Each `AgentConversationTurnStructure.user_message`, `steps[]`, and the outer
 * `ConversationStateStructure.turns[]` entry is a blob ID into `blobStore`.
 */
function buildConversationTurns(
	messages: Message[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): Uint8Array[] {
	const turns: Uint8Array[] = [];
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const toolResults = new Map<string, ToolResultMessage>();
	const pairedToolCallIds = new Set<string>();
	for (let index = 0; index < historyEnd; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			toolResults.set(message.toolCallId, message);
		} else if (message.role === "assistant") {
			for (const item of message.content) {
				if (item.type === "toolCall") pairedToolCallIds.add(item.id);
			}
		}
	}

	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role !== "user") {
			i++;
			continue;
		}
		if (i === activeUserMessageIndex) break;

		const userText = extractUserMessageText(msg);
		if (userText.length === 0 && !hasUserMessageImages(msg)) {
			i++;
			continue;
		}

		const userMessage = createCursorUserMessage(
			msg.content,
			userText,
			deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
		);
		const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage));
		const stepBlobIds: Uint8Array[] = [];
		i++;

		while (i < messages.length && messages[i].role !== "user") {
			const stepMsg = messages[i];
			if (stepMsg.role === "assistant") {
				for (const item of stepMsg.content) {
					let step: ConversationStep;
					if (item.type === "text") {
						if (!item.text) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "assistantMessage",
								value: create(AssistantMessageSchema, { text: item.text }),
							},
						});
					} else if (item.type === "thinking") {
						// Same guard as root-prompt replay: only same-model Cursor K3
						// thinking is replayed, so foreign/hidden reasoning never leaks
						// into Cursor's turn history as native thinking.
						if (!item.thinking || !canReplayCursorThinking(stepMsg, targetModelId)) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "thinkingMessage",
								value: create(ThinkingMessageSchema, { text: item.thinking }),
							},
						});
					} else if (item.type === "toolCall") {
						step = createCursorToolCallStep(item, toolResults.get(item.id));
					} else {
						continue;
					}
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			} else if (stepMsg.role === "toolResult" && !pairedToolCallIds.has(stepMsg.toolCallId)) {
				const text = toolResultToText(stepMsg);
				if (text) {
					const prefix = stepMsg.isError ? "[Tool Error]" : "[Tool Result]";
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text: `${prefix}\n${text}` }),
						},
					});
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			}
			i++;
		}

		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBlobId,
			steps: stepBlobIds,
		});
		const turn = create(ConversationTurnStructureSchema, {
			turn: {
				case: "agentConversationTurn",
				value: agentTurn,
			},
		});
		turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
	}

	return turns;
}

/** Exported for tests: decodes Cursor history blobs built from conversation messages. */
export function buildCursorHistoryForTest(
	messages: Message[],
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): {
	rootPromptMessagesJson: unknown[];
	turnUserMessagesJson: JsonValue[];
	turnStepMessagesJson: JsonValue[][];
} {
	const blobStore = new Map<string, Uint8Array>();
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		messages,
		[],
		blobStore,
		activeUserMessageIndex,
		targetModelId,
	).map((blobId) => JSON.parse(new TextDecoder().decode(readCursorBlob(blobStore, blobId))));
	const turnUserMessagesJson: JsonValue[] = [];
	const turnStepMessagesJson: JsonValue[][] = [];
	for (const turnBlobId of buildConversationTurns(messages, blobStore, activeUserMessageIndex, targetModelId)) {
		const turn = fromBinary(ConversationTurnStructureSchema, readCursorBlob(blobStore, turnBlobId));
		if (turn.turn.case !== "agentConversationTurn") {
			continue;
		}
		const userMessage = fromBinary(UserMessageSchema, readCursorBlob(blobStore, turn.turn.value.userMessage));
		turnUserMessagesJson.push(toJson(UserMessageSchema, userMessage));
		turnStepMessagesJson.push(
			turn.turn.value.steps.map((stepBlobId) => {
				const step = fromBinary(ConversationStepSchema, readCursorBlob(blobStore, stepBlobId));
				return toJson(ConversationStepSchema, step);
			}),
		);
	}
	return { rootPromptMessagesJson, turnUserMessagesJson, turnStepMessagesJson };
}
function createCursorUserMessage(
	content: string | (TextContent | ImageContent)[],
	text: string,
	messageId = crypto.randomUUID(),
) {
	const images = typeof content === "string" ? [] : extractImages(content);
	return create(UserMessageSchema, {
		text,
		messageId,
		...(images.length > 0
			? {
					selectedContext: create(SelectedContextSchema, {
						selectedImages: images,
					}),
				}
			: {}),
	});
}

function extractImages(content: (TextContent | ImageContent)[]) {
	return content
		.filter((item): item is ImageContent => item.type === "image")
		.map((image) =>
			create(SelectedImageSchema, {
				uuid: crypto.randomUUID(),
				mimeType: image.mimeType,
				dataOrBlobId: {
					case: "data",
					value: Uint8Array.from(Buffer.from(image.data, "base64")),
				},
			}),
		);
}

async function buildGrpcRequest(
	model: Model<"cursor-not-cloud">,
	context: Context,
	options: CursorOptions | undefined,
	state: {
		conversationId: string;
		blobStore: Map<string, Uint8Array>;
		conversationState?: ConversationStateStructure;
		signal?: AbortSignal;
	},
): Promise<{
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	conversationState: ConversationStateStructure;
}> {
	const blobStore = state.blobStore;

	const systemPromptIds = buildCursorSystemPromptJsons(context.systemPrompt).map((json) =>
		storeCursorBlob(blobStore, new TextEncoder().encode(json)),
	);

	const activeUserMessageIndex = context.messages.length - 1;
	const activeMessage = context.messages[activeUserMessageIndex];
	const activeUserMessage = activeMessage?.role === "user" ? activeMessage : undefined;
	let userContent: string | (TextContent | ImageContent)[] | undefined;
	let userText = "";
	let hasUserImages = false;
	if (activeUserMessage?.role === "user") {
		userContent = activeUserMessage.content;
		if (typeof userContent === "string") {
			userText = userContent.trim();
		} else {
			userText = extractText(userContent);
			hasUserImages = hasImages(userContent);
		}
	}

	const action = create(ConversationActionSchema, {
		action:
			userContent && (userText.trim().length > 0 || hasUserImages)
				? {
						case: "userMessageAction",
						value: create(UserMessageActionSchema, {
							userMessage: createCursorUserMessage(userContent, userText),
						}),
					}
				: {
						case: "resumeAction",
						value: create(ResumeActionSchema, {}),
					},
	});

	// Build conversation turns from prior messages, excluding only the active user message
	// when the request is sending one. Resume actions must preserve trailing tool results.
	const turns = buildConversationTurns(
		context.messages,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
		model.id,
	);

	// Build `rootPromptMessagesJson` from prior messages. Cursor's server uses this
	// field (not `turns[]`) to construct the actual model prompt; if we only send the
	// system prompt here, multi-turn conversations lose prior context and the model
	// sees only the current user message.
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		context.messages,
		systemPromptIds,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
		model.id,
	);

	// Preserve cached non-history state fields (todos, file states, summaries, etc.)
	// when the system prompt is unchanged; otherwise start fresh.
	const cachedPromptHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
	const hasMatchingPrompt =
		cachedPromptHead.length === systemPromptIds.length &&
		systemPromptIds.every((id, idx) => Buffer.from(cachedPromptHead[idx]).equals(id));
	const baseState =
		state.conversationState && hasMatchingPrompt
			? state.conversationState
			: create(ConversationStateStructureSchema, {
					rootPromptMessagesJson: systemPromptIds,
					turns: [],
					todos: [],
					pendingToolCalls: [],
					previousWorkspaceUris: [],
					fileStates: {},
					fileStatesV2: {},
					summaryArchives: [],
					turnTimings: [],
					subagentStates: {},
					selfSummaryCount: 0,
					readPaths: [],
				});

	// Always override `rootPromptMessagesJson` and `turns` with content freshly built from
	// `context.messages`. The server-echoed checkpoint replaces historical user entries
	// with empty placeholders, so we cannot rely on the cached `rootPromptMessagesJson`.
	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		rootPromptMessagesJson,
		turns,
	});

	const wireModelId = resolveCursorWireModelId(model, options);
	const cursorMaxMode = model.cursorMaxMode === true;
	const modelDetails = create(ModelDetailsSchema, {
		modelId: wireModelId,
		displayModelId: model.id,
		displayName: model.name,
		...(cursorMaxMode ? { maxMode: true } : undefined),
	});
	const requestedModel = create(RequestedModelSchema, {
		modelId: wireModelId,
		maxMode: cursorMaxMode,
	});

	const runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: state.conversationId,
	});

	// Tools are sent later via requestContext (exec handshake)

	if (options?.customSystemPrompt) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}

	let payload: AgentRunRequest = runRequest;
	if (options?.onPayload) {
		const transformed = await raceCursorExecWithAbort(
			Promise.resolve(options.onPayload(runRequest, model)),
			state.signal,
		);
		if (transformed !== undefined) payload = transformed as AgentRunRequest;
	}

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: payload },
	});

	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);

	const toolNames = context.tools?.map((tool) => tool.name) ?? [];
	const detail =
		$env.DEBUG_CURSOR === "2"
			? ` ${JSON.stringify(clientMessage.message.value, debugReplacer, 2)?.slice(0, 2000)}`
			: "";
	log("info", "builtRunRequest", {
		bytes: requestBytes.length,
		tools: toolNames.length,
		toolNames: toolNames.slice(0, 20),
		detail: detail || undefined,
	});

	return { requestBytes, blobStore, conversationState };
}

function hasImages(content: (TextContent | ImageContent)[]): boolean {
	return content.some((item) => item.type === "image");
}
function extractText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

const CURSOR_GROK_FAST_ROUTES: Readonly<Record<string, string>> = {
	"cursor-grok-4.5-low": "cursor-grok-4.5-low-fast",
	"cursor-grok-4.5-medium": "cursor-grok-4.5-medium-fast",
	"cursor-grok-4.5-high": "cursor-grok-4.5-high-fast",
};

const CURSOR_GROK_FAST_ROUTE_IDS: ReadonlySet<string> = new Set(Object.values(CURSOR_GROK_FAST_ROUTES));

/**
 * Published Grok 4.5 Fast rates (https://cursor.com/docs/models/grok-4-5):
 * $4/M input, $18/M output — above the standard $2/$6 model metadata. Cursor publishes no separate cache price; cache usage remains unpriced.
 */
const CURSOR_GROK_FAST_COST = { input: 4, output: 18 } as const;

/** Concrete wire model a request runs against: the routed sibling id when reasoning/fast routing resolved one. */
function resolveCursorWireModelId(model: Model<"cursor-not-cloud">, options: CursorOptions | undefined): string {
	return resolveCursorAgentModelId(model, options);
}

/** Exported for tests: bill fast routes at fast rates, everything else at the model's standard metadata. */
export function calculateCursorAgentUsageCost(
	model: Model<"cursor-not-cloud">,
	wireModelId: string,
	usage: Usage,
): Usage["cost"] {
	const billed = CURSOR_GROK_FAST_ROUTE_IDS.has(wireModelId)
		? { ...model, cost: { ...model.cost, ...CURSOR_GROK_FAST_COST } }
		: model;
	return calculateCost(billed, usage);
}

/** Resolve Prime reasoning and fast state to an exact current Cursor wire model ID. */
export function resolveCursorAgentModelId(
	model: Model<"cursor-not-cloud">,
	options?: { reasoning?: ModelThinkingLevel; serviceTier?: ServiceTier },
): string {
	const requested = options?.reasoning ?? "high";
	const resolved = clampThinkingLevel(model, requested);
	const mapped = model.thinkingLevelMap?.[resolved];
	if (typeof mapped !== "string" || !CURSOR_GROK_45_NORMAL_ROUTE_IDS.some((route) => route === mapped)) {
		throw new AIError.ProviderResponseError(
			`Cursor Grok 4.5 does not expose a wire route for resolved reasoning level ${resolved}`,
			{ provider: "cursor-not-cloud", kind: "capability" },
		);
	}
	if (options?.serviceTier !== "priority") return mapped;
	const fastRoute = CURSOR_GROK_FAST_ROUTES[mapped];
	if (!fastRoute) {
		throw new AIError.ProviderResponseError(`Cursor fast mode is unavailable for reasoning level ${resolved}`, {
			provider: "cursor-not-cloud",
			kind: "capability",
		});
	}
	return fastRoute;
}

/** Provider-agnostic option mapping plus Cursor sibling-model routing. */
export const streamSimpleCursorAgent: StreamFunction<"cursor-not-cloud", SimpleStreamOptions> = (
	model,
	context,
	options,
): AssistantMessageEventStream => {
	return streamCursor(model, context, {
		...buildBaseOptions(model, options),
		reasoning: options?.reasoning,
		serviceTier: options?.serviceTier,
		execHandlers: options?.cursorExecHandlers,
		onToolResult: options?.cursorOnToolResult ?? options?.cursorExecHandlers?.onToolResult,
	});
};

export {
	CURSOR_DISCOVERY_FRESH_TTL_MS,
	CURSOR_DISCOVERY_STALE_TTL_MS,
	CURSOR_GROK_45_FAST_ROUTE_IDS,
	CURSOR_GROK_45_NORMAL_ROUTE_IDS,
	CURSOR_GROK_45_ROUTE_IDS,
	CursorDiscoveryError,
	clearCursorAgentDiscoveryCache,
	fetchCursorAgentModelIds,
	getCursorAgentModelCatalog,
	hasCursorAgentLogicalModelRoutes,
	validateCursorAgentRoute,
} from "./discovery.js";
export {
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadPath,
	piTimeout,
} from "./exec-modern.js";
export { CursorIdentityError, fetchCursorAccountIdentity } from "./identity.js";

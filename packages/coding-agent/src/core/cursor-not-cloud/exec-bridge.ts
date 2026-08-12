import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
	CursorExecHandlers,
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorTodoSnapshot,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	piEscapeRegexLiteral,
	piGrepSkip,
	piJoinPath,
	piLimit,
	piLsPath,
	piReadPath,
	piTimeout,
} from "@earendil-works/pi-ai/cursor-not-cloud";

interface CursorExecBridgeOptions {
	getTools: () => readonly AgentTool[];
	emitEvent?: (event: AgentEvent) => void | Promise<void>;
	executeTool?: (
		toolName: string,
		toolCallId: string,
		args: Record<string, unknown>,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		skipBeforeToolCall?: boolean,
		signal?: AbortSignal,
	) => Promise<{ result: AgentToolResult<unknown>; isError: boolean }>;
	approveTool?: (toolName: string, toolCallId: string, args: Record<string, unknown>) => Promise<boolean>;
}

function emitDetached(options: CursorExecBridgeOptions, event: AgentEvent): void {
	void Promise.resolve(options.emitEvent?.(event)).catch(() => {
		// Streaming/todo callbacks cannot await event listeners. A listener failure
		// must not become an unhandled rejection or strand Cursor's exec response.
	});
}

function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	streamCallbacks?: CursorShellStreamCallbacks,
	skipBeforeToolCall = false,
	signal?: AbortSignal,
): Promise<ToolResultMessage> {
	const tool = options.getTools().find((candidate) => candidate.name === toolName);
	if (!tool) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}

	try {
		await options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args });
	} catch {
		// Renderer/observer failures must not prevent or duplicate the real side effect.
	}

	let result: AgentToolResult<unknown>;
	let isError = false;

	let streamedText = "";
	let updateEventChain = Promise.resolve();
	const onUpdate: AgentToolUpdateCallback<unknown> | undefined =
		options.emitEvent || streamCallbacks
			? (partialResult) => {
					if (options.emitEvent) {
						updateEventChain = updateEventChain
							.then(() =>
								options.emitEvent?.({
									type: "tool_execution_update",
									toolCallId,
									toolName,
									args,
									partialResult,
								}),
							)
							.catch(() => {
								// Observer failures do not alter the provider-owned tool result.
							});
					}
					if (streamCallbacks) {
						const text = partialResult.content
							.filter((item): item is { type: "text"; text: string } => item.type === "text")
							.map((item) => item.text)
							.join("");
						if (text.startsWith(streamedText)) {
							const delta = text.slice(streamedText.length);
							if (delta) {
								try {
									streamCallbacks.onStdout(delta);
								} catch {
									// Streaming observers are isolated from tool execution/result delivery.
								}
							}
							streamedText = text;
						}
					}
				}
			: undefined;

	try {
		if (options.executeTool) {
			const executed = await options.executeTool(toolName, toolCallId, args, onUpdate, skipBeforeToolCall, signal);
			result = executed.result;
			isError = executed.isError;
		} else {
			result = await tool.execute(toolCallId, args as Record<string, unknown>, signal, onUpdate);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = buildToolErrorResult(message);
		isError = true;
	}

	await updateEventChain;

	if (streamCallbacks) {
		const finalText = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");
		if (finalText.startsWith(streamedText)) {
			const delta = finalText.slice(streamedText.length);
			if (delta) {
				try {
					streamCallbacks.onStdout(delta);
				} catch {
					// Streaming observers are isolated from tool execution/result delivery.
				}
			}
		}
	}

	try {
		await options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result, isError });
	} catch {
		// The authoritative result is still delivered below.
	}

	return createToolResultMessage(toolCallId, toolName, result, isError);
}

function decodeToolCallId(toolCallId?: string): string {
	return toolCallId && toolCallId.length > 0 ? toolCallId : randomUUID();
}

function decodeMcpArgs(rawArgs: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		const text = new TextDecoder().decode(value);
		try {
			decoded[key] = JSON.parse(text);
		} catch {
			decoded[key] = text;
		}
	}
	return decoded;
}

function formatMcpToolErrorMessage(toolName: string, availableTools: string[]): string {
	const list = availableTools.length > 0 ? availableTools.join(", ") : "none";
	return `MCP tool "${toolName}" not found. Available tools: ${list}`;
}

function stableApprovalValue(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	if (Array.isArray(value)) return value.map(stableApprovalValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableApprovalValue(entry)]),
		);
	}
	return value;
}

function mcpApprovalSignature(toolName: string, args: Record<string, unknown>): string {
	return JSON.stringify([toolName, stableApprovalValue(args)]);
}

export function createCursorExecHandlers(options: CursorExecBridgeOptions): CursorExecHandlers {
	const approvedMcpCalls = new Map<string, string>();
	return {
		read: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			const toolResultMessage = await executeTool(
				options,
				"read",
				toolCallId,
				{ path: args.path },
				undefined,
				false,
				context?.signal,
			);
			return toolResultMessage;
		},
		ls: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			const toolResultMessage = await executeTool(
				options,
				"read",
				toolCallId,
				{ path: args.path },
				undefined,
				false,
				context?.signal,
			);
			return toolResultMessage;
		},
		grep: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			const searchPath = args.glob ? piJoinPath(args.path || ".", args.glob) : args.path || ".";
			return await executeTool(
				options,
				"grep",
				toolCallId,
				{
					pattern: args.pattern,
					path: searchPath,
					case: args.caseInsensitive === true ? false : undefined,
					skip: piGrepSkip(args.offset),
				},
				undefined,
				false,
				context?.signal,
			);
		},
		write: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
			return await executeTool(
				options,
				"write",
				toolCallId,
				{ path: args.path, content },
				undefined,
				false,
				context?.signal,
			);
		},
		delete: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			return await executeTool(
				options,
				"delete",
				toolCallId,
				{ path: args.path },
				undefined,
				false,
				context?.signal,
			);
		},
		shell: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			const timeoutSeconds = args.timeout && args.timeout > 0 ? args.timeout : undefined;
			return await executeTool(
				options,
				"bash",
				toolCallId,
				{ command: args.command, cwd: args.workingDirectory || undefined, timeout: timeoutSeconds },
				undefined,
				false,
				context?.signal,
			);
		},
		shellStream: async (args, callbacks, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			return await executeTool(
				options,
				"bash",
				toolCallId,
				{
					command: args.command,
					cwd: args.workingDirectory || undefined,
					timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
				},
				callbacks,
				false,
				context?.signal,
			);
		},
		diagnostics: async (args, context) => {
			const toolCallId = decodeToolCallId(args.toolCallId);
			return await executeTool(
				options,
				"lsp",
				toolCallId,
				{ action: "diagnostics", file: args.path },
				undefined,
				false,
				context?.signal,
			);
		},
		piRead: async (call, context) => {
			const path = piReadPath(call.args.path, call.args.offset, call.args.limit);
			if (path === null) {
				return createToolResultMessage(
					call.toolCallId,
					"read",
					{ content: [{ type: "text", text: "" }], details: {} },
					false,
				);
			}
			return await executeTool(options, "read", call.toolCallId, { path }, undefined, false, context?.signal);
		},
		piBash: async (call, context) =>
			await executeTool(
				options,
				"bash",
				call.toolCallId,
				{ command: call.args.command, timeout: piTimeout(call.args.timeout) },
				undefined,
				false,
				context?.signal,
			),
		piEdit: async (call, context) =>
			await executeTool(
				options,
				"edit",
				call.toolCallId,
				{
					path: call.args.path,
					edits: call.args.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
				},
				undefined,
				false,
				context?.signal,
			),
		piWrite: async (call, context) =>
			await executeTool(
				options,
				"write",
				call.toolCallId,
				{ path: call.args.path, content: call.args.content },
				undefined,
				false,
				context?.signal,
			),
		piGrep: async (call, context) =>
			await executeTool(
				options,
				"grep",
				call.toolCallId,
				{
					pattern: call.args.literal ? piEscapeRegexLiteral(call.args.pattern) : call.args.pattern,
					path: call.args.glob ? piJoinPath(call.args.path, call.args.glob) : call.args.path || ".",
					case: call.args.ignoreCase ? false : undefined,
					context: call.args.context,
					limit: piLimit(call.args.limit),
				},
				undefined,
				false,
				context?.signal,
			),
		piFind: async (call, context) =>
			await executeTool(
				options,
				"glob",
				call.toolCallId,
				{ path: piJoinPath(call.args.path, call.args.pattern), limit: piLimit(call.args.limit) },
				undefined,
				false,
				context?.signal,
			),
		piLs: async (call, context) =>
			await executeTool(
				options,
				"read",
				call.toolCallId,
				{ path: piLsPath(call.args.path) },
				undefined,
				false,
				context?.signal,
			),
		listMcpResources: async () => [],
		readMcpResource: async () => null,
		todoSync: (snapshot: CursorTodoSnapshot | null, toolCallId: string, error: string | null) => {
			const text = error
				? `Todo sync failed: ${error}`
				: snapshot
					? `${snapshot.todos.filter((todo) => todo.status === "completed").length}/${snapshot.todos.length} tasks completed`
					: "Todo snapshot not mirrored";
			const result = createToolResultMessage(
				toolCallId,
				"todo",
				{ content: [{ type: "text", text }], details: snapshot ? { snapshot } : {} },
				error !== null,
			);
			emitDetached(options, {
				type: "tool_execution_end",
				toolCallId,
				toolName: "todo",
				result: { content: result.content, details: result.details },
				isError: result.isError,
			});
			return result;
		},
		mcpApprovalPreflight: async (call, _context) => {
			const toolName = call.toolName || call.name;
			if (!options.getTools().some((candidate) => candidate.name === toolName)) return false;
			const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
			const approved = options.approveTool ? await options.approveTool(toolName, call.toolCallId, args) : true;
			if (approved) {
				if (approvedMcpCalls.size >= 128) {
					const oldest = approvedMcpCalls.keys().next().value;
					if (oldest !== undefined) approvedMcpCalls.delete(oldest);
				}
				approvedMcpCalls.set(call.toolCallId, mcpApprovalSignature(toolName, args));
			}
			return approved;
		},
		mcp: async (call: CursorMcpCall, context) => {
			const toolName = call.toolName || call.name;
			const toolCallId = decodeToolCallId(call.toolCallId);
			const tool = options.getTools().find((candidate) => candidate.name === toolName);
			if (!tool) {
				const availableTools = options.getTools().map((tool) => tool.name);
				const message = formatMcpToolErrorMessage(toolName, availableTools);
				const toolResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId,
					toolName,
					content: [{ type: "text", text: message }],
					details: {},
					isError: true,
					timestamp: Date.now(),
				};
				return toolResult;
			}

			const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
			const approvalSignature = approvedMcpCalls.get(call.toolCallId);
			approvedMcpCalls.delete(call.toolCallId);
			const skipBeforeToolCall = approvalSignature === mcpApprovalSignature(toolName, args);
			const toolResultMessage = await executeTool(
				options,
				toolName,
				toolCallId,
				args,
				undefined,
				skipBeforeToolCall,
				context?.signal,
			);
			return toolResultMessage;
		},
	};
}

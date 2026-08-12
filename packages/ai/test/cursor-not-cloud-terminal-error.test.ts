import { getEventListeners } from "node:events";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	InteractionUpdateSchema,
	ReadArgsSchema,
	TextDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
	UpdateTodosArgsSchema,
	UpdateTodosToolCallSchema,
} from "../src/providers/cursor-not-cloud/agent_pb.js";
import { streamCursor } from "../src/providers/cursor-not-cloud/index.js";
import type { Context, CursorToolResultHandler, Model, ToolResultMessage } from "../src/types.js";

type TestPromiseWithResolvers<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};

function testPromiseWithResolvers<T>(): TestPromiseWithResolvers<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const CONNECT_END_STREAM_FLAG = 0b00000010;

type Scenario =
	| { kind: "success" }
	| { kind: "missing-end-after-turn" }
	| { kind: "duplicate-end" }
	| { kind: "end-envelope-before-turn" }
	| { kind: "malformed-end" }
	| { kind: "http-error" }
	| { kind: "http-error-with-exec" }
	| { kind: "wrong-content-with-exec" }
	| { kind: "connect-error-after-turn" }
	| { kind: "grpc-trailer-after-turn" }
	| { kind: "malformed-grpc-trailer" }
	| { kind: "end-before-turn" }
	| { kind: "hang-after-turn" }
	| { kind: "exec-in-final-chunk"; responseFinished: TestPromiseWithResolvers<void> }
	| { kind: "exec-then-transport-error"; responseFinished: TestPromiseWithResolvers<void> }
	| { kind: "exec-then-hang" }
	| { kind: "todo-start-then-death" }
	| { kind: "compressed-frame" }
	| { kind: "unknown-flags" }
	| { kind: "truncated-frame" }
	| { kind: "malformed-protobuf" }
	| { kind: "oversized-frame" };

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();
let scenario: Scenario = { kind: "success" };

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "textDelta",
					value: create(TextDeltaUpdateSchema, { text }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "turnEnded",
					value: create(TurnEndedUpdateSchema, {}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function connectEndErrorFrame(code: string, message: string): Buffer {
	const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
	return frameConnectMessage(payload, CONNECT_END_STREAM_FLAG);
}

function connectEndFrame(): Buffer {
	return frameConnectMessage(Buffer.from("{}", "utf8"), CONNECT_END_STREAM_FLAG);
}

/**
 * A `read` exec request. The provider parses every frame in a chunk
 * synchronously and dispatches each `handleServerMessage` fire-and-forget, so
 * pairing this with a terminal frame in ONE chunk leaves the exec handler
 * running while the transport settles.
 */
function execRequestFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: "exec-final",
				message: {
					case: "readArgs",
					value: create(ReadArgsSchema, { path: "/tmp/final", toolCallId: "call-final" }),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

/**
 * Exec request + `turnEnded` in one chunk: the clean-completion race. Without a
 * barrier before `done`, the Agent drains its Cursor result buffer first and
 * the call is never paired.
 */
function execAndTurnEndedFrame(): Buffer {
	return Buffer.concat([execRequestFrame(), turnEndedFrame()]);
}

/**
 * A native `update_todos` call announcement. Cursor runs these server-side, so
 * the block is stamped resolved at start and only its `toolCallCompleted`
 * frame pairs a result — nothing downstream synthesizes one.
 */
function todoStartFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "toolCallStarted",
					value: create(ToolCallStartedUpdateSchema, {
						callId: "todo-envelope",
						toolCall: create(ToolCallSchema, {
							tool: {
								case: "updateTodosToolCall",
								value: create(UpdateTodosToolCallSchema, {
									args: create(UpdateTodosArgsSchema, { todos: [] }),
								}),
							},
						}),
					}),
				},
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("session", (session) => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		stream.on("data", () => {});

		if (headers[":path"] !== "/agent.v1.AgentService/Run") {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}

		if (scenario.kind === "http-error" || scenario.kind === "http-error-with-exec") {
			stream.respond({ ":status": 401, "content-type": "application/connect+proto" });
			if (scenario.kind === "http-error-with-exec") stream.write(execRequestFrame());
			stream.end();
			return;
		}
		if (scenario.kind === "wrong-content-with-exec") {
			stream.respond({ ":status": 200, "content-type": "text/plain" });
			stream.end(execRequestFrame());
			return;
		}

		if (scenario.kind === "grpc-trailer-after-turn" || scenario.kind === "malformed-grpc-trailer") {
			stream.respond(
				{
					":status": 200,
					"content-type": "application/connect+proto",
				},
				{ waitForTrailers: true },
			);
			stream.on("wantTrailers", () => {
				stream.sendTrailers({
					"grpc-status": "13",
					"grpc-message":
						scenario.kind === "malformed-grpc-trailer" ? "%" : encodeURIComponent("post-turn trailer failure"),
				});
			});
			stream.write(textDeltaFrame("hello"));
			stream.write(turnEndedFrame());
			stream.write(connectEndFrame());
			stream.end();
			return;
		}

		stream.respond({
			":status": 200,
			"content-type": "application/connect+proto",
		});

		if (scenario.kind === "missing-end-after-turn") {
			stream.end(Buffer.concat([textDeltaFrame("hello"), turnEndedFrame()]));
			return;
		}
		if (scenario.kind === "duplicate-end") {
			stream.end(Buffer.concat([turnEndedFrame(), connectEndFrame(), connectEndFrame()]));
			return;
		}
		if (scenario.kind === "end-envelope-before-turn") {
			stream.end(connectEndFrame());
			return;
		}
		if (scenario.kind === "malformed-end") {
			stream.end(Buffer.concat([turnEndedFrame(), frameConnectMessage(Buffer.from("[]"), CONNECT_END_STREAM_FLAG)]));
			return;
		}

		if (scenario.kind === "end-before-turn") {
			stream.write(textDeltaFrame("partial"));
			stream.end();
			return;
		}

		if (scenario.kind === "todo-start-then-death") {
			// The server announces a native todo call, then the stream dies
			// without `turnEnded` and without the call's completion frame. This
			// is the real interrupted-call shape: `settleH2` rejects, so the
			// success-path flush never runs.
			stream.write(todoStartFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "exec-in-final-chunk") {
			const { responseFinished } = scenario;
			// Resolves once the server has flushed the whole response, so the test
			// never guesses at timing.
			stream.on("finish", () => responseFinished.resolve());
			stream.write(execAndTurnEndedFrame());
			stream.write(connectEndFrame());
			stream.end();
			return;
		}

		if (scenario.kind === "exec-then-transport-error") {
			const { responseFinished } = scenario;
			stream.on("finish", () => responseFinished.resolve());
			// The exec request and the failure land in ONE chunk: the handler is
			// dispatched fire-and-forget and is still running when the transport
			// rejects. `turnEnded` is deliberately absent — this is the turn dying,
			// not ending.
			stream.write(
				Buffer.concat([execRequestFrame(), connectEndErrorFrame("unavailable", "mid-exec transport failure")]),
			);
			stream.end();
			return;
		}

		if (scenario.kind === "exec-then-hang") {
			// Exec request, then the stream stays open: the only way this turn
			// ends is the client aborting.
			stream.write(execRequestFrame());
			return;
		}

		if (scenario.kind === "compressed-frame") {
			stream.end(frameConnectMessage(new Uint8Array(), 1));
			return;
		}
		if (scenario.kind === "unknown-flags") {
			stream.end(frameConnectMessage(new Uint8Array(), 4));
			return;
		}
		if (scenario.kind === "truncated-frame") {
			stream.end(Buffer.from([0, 0, 0, 0, 4, 1]));
			return;
		}
		if (scenario.kind === "malformed-protobuf") {
			stream.end(frameConnectMessage(new Uint8Array([0xff])));
			return;
		}
		if (scenario.kind === "oversized-frame") {
			const header = Buffer.alloc(5);
			header.writeUInt32BE(32 * 1024 * 1024 + 1, 1);
			stream.end(header);
			return;
		}

		stream.write(Buffer.concat([textDeltaFrame("hello"), turnEndedFrame()]));

		if (scenario.kind === "connect-error-after-turn") {
			stream.write(connectEndErrorFrame("unavailable", "post-turn connect failure"));
			return;
		}

		if (scenario.kind === "hang-after-turn") {
			return;
		}

		stream.write(connectEndFrame());
		stream.end();
	});

	const listening = testPromiseWithResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected http2 fixture server to bind a tcp port");
	}
	return `http://127.0.0.1:${address.port}`;
}

function makeModel(baseUrl: string): Model<"cursor-not-cloud"> {
	return {
		id: "cursor-grok-4.5-high",
		name: "Cursor Grok 4.5",
		api: "cursor-not-cloud",
		provider: "cursor-not-cloud",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: {
			low: "cursor-grok-4.5-low",
			medium: "cursor-grok-4.5-medium",
			high: "cursor-grok-4.5-high",
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

const context: Context = {
	messages: [{ role: "user", content: "terminal lifecycle", timestamp: 1 }],
};

async function collectStream(
	model: Model<"cursor-not-cloud">,
	options?: { signal?: AbortSignal; onToolResult?: CursorToolResultHandler; timeoutMs?: number },
) {
	const stream = streamCursor(model, context, {
		apiKey: "test-token",
		discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
		signal: options?.signal,
		timeoutMs: options?.timeoutMs,
		onToolResult: options?.onToolResult,
	});
	const eventTypes: string[] = [];
	for await (const event of stream) {
		eventTypes.push(event.type);
	}
	const result = await stream.result();
	return { eventTypes, result };
}

async function stopServer(): Promise<void> {
	for (const session of sessions) {
		session.destroy();
	}
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = testPromiseWithResolvers<void>();
	closing.close((error) => {
		if (error) {
			closed.reject(error);
		} else {
			closed.resolve();
		}
	});
	await closed.promise;
}

afterEach(async () => {
	scenario = { kind: "success" };
	await stopServer();
});

describe("Cursor terminal lifecycle after turnEnded", () => {
	it("emits done only after turnEnded and a clean protocol end", async () => {
		scenario = { kind: "success" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it.each([
		["missing-end-after-turn", /before the Connect end envelope/i],
		["duplicate-end", /duplicate Connect end envelopes/i],
		["end-envelope-before-turn", /before turnEnded/i],
		["malformed-end", /invalid shape/i],
	] as const)("rejects strict terminal ordering: %s", async (kind, message) => {
		scenario = { kind };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.errorMessage).toMatch(message);
	});

	it.each(["http-error-with-exec", "wrong-content-with-exec"] as const)(
		"never dispatches server messages from rejected response %s",
		async (kind) => {
			scenario = { kind };
			const baseUrl = await startServer();
			let calls = 0;
			const stream = streamCursor(makeModel(baseUrl), context, {
				apiKey: "test-token",
				discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
				execHandlers: {
					async read() {
						calls++;
						throw new Error("must not run");
					},
				},
			});
			for await (const _event of stream) {
				/* drain */
			}
			expect((await stream.result()).stopReason).toBe("error");
			expect(calls).toBe(0);
		},
	);

	it("surfaces non-success HTTP status instead of reporting a silent stream end", async () => {
		scenario = { kind: "http-error" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Provider authentication failed");
	});

	it("surfaces CONNECT end-stream errors that arrive after turnEnded", async () => {
		scenario = { kind: "connect-error-after-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connect error unavailable: post-turn connect failure");
	});

	it("surfaces nonzero gRPC trailers that arrive after turnEnded", async () => {
		scenario = { kind: "grpc-trailer-after-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("gRPC error 13: post-turn trailer failure");
	});

	it("safely renders malformed percent escapes in gRPC messages", async () => {
		scenario = { kind: "malformed-grpc-trailer" };
		const baseUrl = await startServer();
		const { result } = await collectStream(makeModel(baseUrl));
		expect(result.errorMessage).toContain("gRPC error 13: %");
	});

	it("rejects when the stream ends before turnEnded", async () => {
		scenario = { kind: "end-before-turn" };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Cursor stream ended before turnEnded");
	});

	it("pairs and closes a server-owned call the dying stream left open", async () => {
		// The failure this guards: a native todo block is stamped resolved at
		// start, so `agent-loop.ts` synthesizes no placeholder for it and only
		// its completion frame pairs a result. When the transport dies first the
		// call went unpaired and its card stayed animating — and
		// `buildSessionContext` strips a dangling call, so the interaction
		// vanished from every rebuilt transcript.
		//
		// This must run against the real terminal-error path: `settleH2` rejects
		// on a stream that ends before `turnEnded`, so the success path's flush
		// is never reached.
		scenario = { kind: "todo-start-then-death" };
		const baseUrl = await startServer();
		const paired: ToolResultMessage[] = [];
		const { eventTypes, result } = await collectStream(makeModel(baseUrl), {
			onToolResult: (toolResult) => void paired.push(toolResult),
		});

		expect(eventTypes.at(-1)).toBe("error");
		expect(result.stopReason).toBe("error");

		const call = result.content.find((block) => block.type === "toolCall");
		if (!call) throw new Error("expected the announced todo call in the output");
		// Closed, so no live card is left animating.
		expect(eventTypes).toContain("toolcall_end");
		// Paired, so replay keeps the interaction.
		expect(paired).toHaveLength(1);
		expect(paired[0].toolCallId).toBe(call.id);
		expect(paired[0].isError).toBe(true);
	});

	it("aborts without emitting done when the signal fires", async () => {
		scenario = { kind: "hang-after-turn" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			signal: controller.signal,
		});
		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await stream.result();
		expect(eventTypes[0]).toBe("start");
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("aborted");
	});

	it("waits for an exec handler decoded from the final chunk before done", async () => {
		// The provider dispatches every decoded message fire-and-forget so the
		// socket keeps draining. When the exec request, `turnEnded` and the close
		// arrive in ONE chunk, the transport completes while the handler is still
		// running. `done` must not be pushed first: the Agent drains its Cursor
		// result buffer on the terminal event, so a result reserved afterwards
		// misses the drain and the synthesized (already resolved) toolCall block
		// is stripped from every rebuilt transcript as dangling.
		//
		// No wall-clock delay. The handler is released only after the server has
		// flushed its whole response AND the handler is known to be running, so
		// the transport has genuinely completed while the handler is in flight.
		const responseFinished = testPromiseWithResolvers<void>();
		scenario = { kind: "exec-in-final-chunk", responseFinished };
		const baseUrl = await startServer();
		const paired: string[] = [];
		const handlerStarted = testPromiseWithResolvers<void>();
		const handlerDone = testPromiseWithResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: (result) => {
				paired.push(result.toolCallId);
				return result;
			},
		});

		const gate = (async () => {
			await Promise.all([handlerStarted.promise, responseFinished.promise]);
			// `finish` means the server flushed its bytes, not that the client has
			// processed the end. Yield so the client's `end` handler and every
			// queued continuation run first: a provider that does not await the
			// handler settles the stream in exactly that window.
			await new Promise((resolve) => setTimeout(resolve, 0));
			try {
				expect(stream.resultSettled).toBe(false);
				expect(paired).toEqual([]);
			} finally {
				// Always release: a failing assertion here must surface as that
				// failure, not as a hung `for await` that waits for a handler
				// nobody will ever unblock.
				handlerDone.resolve();
			}
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			// The result must already be paired by the time `done` is observed.
			if (event.type === "done") expect(paired).toEqual(["call-final"]);
			eventTypes.push(event.type);
		}
		await gate;

		expect(eventTypes).toContain("done");
		expect(paired).toEqual(["call-final"]);
	});

	it("cancels an in-flight exec handler when the transport dies", async () => {
		const responseFinished = testPromiseWithResolvers<void>();
		scenario = { kind: "exec-then-transport-error", responseFinished };
		const baseUrl = await startServer();
		const paired: string[] = [];
		const handlerStarted = testPromiseWithResolvers<void>();
		const handlerDone = testPromiseWithResolvers<void>();
		let handlerSignal: AbortSignal | undefined;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			execHandlers: {
				async read(_args, execContext) {
					handlerSignal = execContext?.signal;
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "late result" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: (result) => {
				paired.push(result.toolCallId);
				return result;
			},
		});

		await Promise.all([handlerStarted.promise, responseFinished.promise]);
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();
		expect(handlerSignal?.aborted).toBe(true);
		expect(eventTypes.at(-1)).toBe("error");
		expect(result.errorMessage).toContain("mid-exec transport failure");
		expect(paired).toEqual(["call-final"]);
		handlerDone.resolve();
	});

	it.each([
		[
			"sync throw",
			() => {
				throw new Error("sink sync failure");
			},
		],
		[
			"promise rejection",
			async () => {
				throw new Error("sink async failure");
			},
		],
	] as const)("fails a clean turn once when onToolResult has a %s", async (_name, sink) => {
		const responseFinished = testPromiseWithResolvers<void>();
		scenario = { kind: "exec-in-final-chunk", responseFinished };
		const baseUrl = await startServer();
		let sinkCalls = 0;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			execHandlers: {
				async read() {
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: (result) => {
				sinkCalls++;
				return Promise.resolve()
					.then(sink)
					.then(() => result);
			},
		});
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		expect((await stream.result()).stopReason).toBe("error");
		expect(events.filter((type) => type === "error")).toHaveLength(1);
		expect(sinkCalls).toBe(1);
	});

	it("bounds a never-resolving onToolResult on an otherwise successful turn", async () => {
		const responseFinished = testPromiseWithResolvers<void>();
		scenario = { kind: "exec-in-final-chunk", responseFinished };
		const baseUrl = await startServer();
		let sinkCalls = 0;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			timeoutMs: 20,
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			execHandlers: {
				async read() {
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
			onToolResult: () => {
				sinkCalls++;
				return new Promise<never>(() => {});
			},
		});
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timeout/i);
		expect(events.filter((type) => type === "error")).toHaveLength(1);
		expect(sinkCalls).toBe(1);
	});

	it.each([
		[
			"sync throw",
			() => {
				throw new Error("sink transport sync failure");
			},
		],
		[
			"promise rejection",
			async () => {
				throw new Error("sink transport async failure");
			},
		],
	] as const)("does not invoke a failing %s sink twice during transport cleanup", async (_name, sink) => {
		scenario = { kind: "todo-start-then-death" };
		const baseUrl = await startServer();
		let sinkCalls = 0;
		const { eventTypes, result } = await collectStream(makeModel(baseUrl), {
			onToolResult: (toolResult) => {
				sinkCalls++;
				return Promise.resolve()
					.then(sink)
					.then(() => toolResult);
			},
		});
		expect(result.stopReason).toBe("error");
		expect(eventTypes.filter((type) => type === "error")).toHaveLength(1);
		expect(sinkCalls).toBe(1);
	});

	it("emits exactly one timeout error for a never-resolving exec without a caller signal", async () => {
		scenario = { kind: "exec-then-hang" };
		const baseUrl = await startServer();
		const started = testPromiseWithResolvers<void>();
		let execSignal: AbortSignal | undefined;
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			timeoutMs: 20,
			execHandlers: {
				async read(_args, execContext) {
					execSignal = execContext?.signal;
					started.resolve();
					return await new Promise<never>(() => {});
				},
			},
		});
		await started.promise;
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);
		const result = await stream.result();
		expect(eventTypes.filter((type) => type === "error")).toHaveLength(1);
		expect(eventTypes).not.toContain("done");
		expect(result.errorMessage).toMatch(/timeout/i);
		expect(execSignal?.aborted).toBe(true);
	});

	it("does not hold the abort hostage to a hung exec handler", async () => {
		// Exec handlers have no cancellation contract — the coding-agent bridge
		// invokes `tool.execute` with no signal — so a hung or long-running tool
		// cannot be interrupted. Once the user aborts, the drain must not wait
		// for it: the Agent finalizes from the abort error and discards late
		// results regardless, so waiting only delays the terminal event the
		// user asked for. Without the abort-bounded drain this test times out
		// with the stream never settling.
		scenario = { kind: "exec-then-hang" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const handlerStarted = testPromiseWithResolvers<void>();
		const handlerDone = testPromiseWithResolvers<void>();
		const stream = streamCursor(makeModel(baseUrl), context, {
			apiKey: "test-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			signal: controller.signal,
			execHandlers: {
				async read() {
					handlerStarted.resolve();
					await handlerDone.promise;
					return {
						role: "toolResult",
						toolCallId: "call-final",
						toolName: "read",
						content: [{ type: "text", text: "late result" }],
						isError: false,
						timestamp: 1,
					};
				},
			},
		});

		const gate = (async () => {
			await handlerStarted.promise;
			controller.abort();
		})();

		const eventTypes: string[] = [];
		for await (const event of stream) {
			eventTypes.push(event.type);
		}
		await gate;
		const result = await stream.result();
		// Released only AFTER the stream settled: reaching this line at all
		// proves the terminal error did not wait for the handler.
		handlerDone.resolve();

		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.stopReason).toBe("aborted");
	});

	it.each([
		["compressed-frame", /compression or flags/i],
		["unknown-flags", /compression or flags/i],
		["truncated-frame", /partial Connect frame/i],
		["malformed-protobuf", /protobuf could not be decoded/i],
		["oversized-frame", /exceeded 32 MiB/i],
	] as const)("rejects malformed terminal protocol: %s", async (kind, message) => {
		scenario = { kind };
		const baseUrl = await startServer();
		const { eventTypes, result } = await collectStream(makeModel(baseUrl));
		expect(eventTypes.at(-1)).toBe("error");
		expect(eventTypes).not.toContain("done");
		expect(result.errorMessage).toMatch(message);
	});

	it("enforces idle/overall timeout and removes the caller abort listener on every terminal path", async () => {
		scenario = { kind: "hang-after-turn" };
		const baseUrl = await startServer();
		const controller = new AbortController();
		const before = getEventListeners(controller.signal, "abort").length;
		const { result } = await collectStream(makeModel(baseUrl), { signal: controller.signal, timeoutMs: 20 });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/timeout/i);
		expect(getEventListeners(controller.signal, "abort").length).toBe(before);
	});
});

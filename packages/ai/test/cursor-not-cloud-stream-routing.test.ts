import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getModel, stream } from "../src/index.js";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor-not-cloud/agent_pb.js";
import { streamCursor } from "../src/providers/cursor-not-cloud/index.js";
import type { Context, Model, ModelThinkingLevel, ServiceTier } from "../src/types.js";

const matrix: Array<[ModelThinkingLevel, ServiceTier, string]> = [
	["off", "default", "cursor-grok-4.5-low"],
	["minimal", "default", "cursor-grok-4.5-low"],
	["low", "default", "cursor-grok-4.5-low"],
	["medium", "default", "cursor-grok-4.5-medium"],
	["high", "default", "cursor-grok-4.5-high"],
	["xhigh", "default", "cursor-grok-4.5-high"],
	["max", "default", "cursor-grok-4.5-high"],
	["off", "priority", "cursor-grok-4.5-low-fast"],
	["minimal", "priority", "cursor-grok-4.5-low-fast"],
	["low", "priority", "cursor-grok-4.5-low-fast"],
	["medium", "priority", "cursor-grok-4.5-medium-fast"],
	["high", "priority", "cursor-grok-4.5-high-fast"],
	["xhigh", "priority", "cursor-grok-4.5-high-fast"],
	["max", "priority", "cursor-grok-4.5-high-fast"],
];
const matrix46: Array<[ModelThinkingLevel, ServiceTier, string]> = [
	["off", "default", "cursor-grok-4.6-low"],
	["minimal", "default", "cursor-grok-4.6-low"],
	["low", "default", "cursor-grok-4.6-low"],
	["medium", "default", "cursor-grok-4.6-medium"],
	["high", "default", "cursor-grok-4.6-high"],
	["xhigh", "default", "cursor-grok-4.6-xhigh"],
	["max", "default", "cursor-grok-4.6-xhigh"],
	["off", "priority", "cursor-grok-4.6-low-fast"],
	["minimal", "priority", "cursor-grok-4.6-low-fast"],
	["low", "priority", "cursor-grok-4.6-low-fast"],
	["medium", "priority", "cursor-grok-4.6-medium-fast"],
	["high", "priority", "cursor-grok-4.6-high-fast"],
	["xhigh", "priority", "cursor-grok-4.6-xhigh-fast"],
	["max", "priority", "cursor-grok-4.6-xhigh-fast"],
];
const context: Context = { messages: [{ role: "user", content: "route", timestamp: 1 }] };
let server: http2.Http2Server;
let baseUrl: string;
const seen: string[] = [];

function frame(body: Uint8Array, flags = 0): Buffer {
	const result = Buffer.alloc(5 + body.length);
	result[0] = flags;
	result.writeUInt32BE(body.length, 1);
	result.set(body, 5);
	return result;
}

beforeAll(async () => {
	server = http2.createServer();
	server.on("stream", (request) => {
		let pending = Buffer.alloc(0);
		let answered = false;
		request.on("data", (chunk: Buffer) => {
			if (answered) return;
			pending = Buffer.concat([pending, chunk]);
			if (pending.length < 5) return;
			const length = pending.readUInt32BE(1);
			if (pending.length < 5 + length) return;
			answered = true;
			const client = fromBinary(AgentClientMessageSchema, pending.subarray(5, 5 + length));
			if (client.message.case !== "runRequest") throw new Error("expected initial run request");
			seen.push(client.message.value.modelDetails?.modelId ?? "");
			request.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const ended = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				},
			});
			request.end(Buffer.concat([frame(toBinary(AgentServerMessageSchema, ended)), frame(Buffer.from("{}"), 2)]));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture bind failed");
	baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => await new Promise<void>((resolve) => server.close(() => resolve())));

function fixtureModel(
	modelId: "cursor-grok-4.5-high" | "cursor-grok-4.6-high" = "cursor-grok-4.5-high",
): Model<"cursor-not-cloud"> {
	const model = getModel("cursor-not-cloud", modelId);
	if (!model) throw new Error("missing model");
	return { ...model, baseUrl };
}

async function assertWireRoute(
	dispatch: typeof streamCursor,
	reasoning: ModelThinkingLevel,
	serviceTier: ServiceTier,
	expected: string,
	modelId: "cursor-grok-4.5-high" | "cursor-grok-4.6-high" = "cursor-grok-4.5-high",
): Promise<void> {
	const before = seen.length;
	const output = await dispatch(fixtureModel(modelId), context, {
		apiKey: "fixture-token",
		reasoning,
		serviceTier,
		discoveredModelIds: new Set([expected]),
	}).result();
	expect(output.stopReason).toBe("stop");
	expect(seen.slice(before)).toEqual([expected]);
}

describe("cursor-not-cloud end-to-end route dispatch", () => {
	it.each(matrix)("direct stream routes %s/%s to %s", async (reasoning, tier, expected) => {
		await assertWireRoute(streamCursor, reasoning, tier, expected);
	});

	it.each(matrix)("registered stream routes %s/%s to %s", async (reasoning, tier, expected) => {
		await assertWireRoute(stream as typeof streamCursor, reasoning, tier, expected);
	});

	it.each(matrix46)("direct Grok 4.6 stream routes %s/%s to %s", async (reasoning, tier, expected) => {
		await assertWireRoute(streamCursor, reasoning, tier, expected, "cursor-grok-4.6-high");
	});

	it.each(matrix46)("registered Grok 4.6 stream routes %s/%s to %s", async (reasoning, tier, expected) => {
		await assertWireRoute(stream as typeof streamCursor, reasoning, tier, expected, "cursor-grok-4.6-high");
	});

	it("rejects an oversized initial Run payload before emitting a Connect frame", async () => {
		const oversized = "x".repeat(32 * 1024 * 1024 + 1);
		const output = await streamCursor({ ...fixtureModel(), baseUrl: "http://127.0.0.1:1" }, context, {
			apiKey: "fixture-token",
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
			customSystemPrompt: oversized,
		}).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toMatch(/outbound Connect frame exceeded 32 MiB/i);
	});
});

import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor-not-cloud/agent_pb.js";
import { streamCursor } from "../src/providers/cursor-not-cloud/index.js";
import type { Context, Model } from "../src/types.js";

let server: http2.Http2Server | undefined;
function frame(body: Uint8Array): Buffer {
	const result = Buffer.alloc(5 + body.length);
	result.writeUInt32BE(body.length, 1);
	result.set(body, 5);
	return result;
}
const context: Context = { messages: [{ role: "user", content: "fixture", timestamp: 1 }] };
function model(baseUrl: string): Model<"cursor-not-cloud"> {
	return {
		id: "cursor-grok-4.5-high",
		name: "Cursor Grok 4.5",
		provider: "cursor-not-cloud",
		api: "cursor-not-cloud",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { low: "cursor-grok-4.5-low", medium: "cursor-grok-4.5-medium", high: "cursor-grok-4.5-high" },
		input: ["text"],
		cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 64000,
	};
}

afterEach(async () => {
	delete process.env.CURSOR_AGENT_TOKEN;
	delete process.env.CURSOR_ACCESS_TOKEN;
	if (!server) return;
	const current = server;
	server = undefined;
	await new Promise<void>((resolve) => current.close(() => resolve()));
});

describe("cursor-not-cloud environment auth fallback", () => {
	it("uses CURSOR_AGENT_TOKEN for standalone pi-ai requests", async () => {
		let authorized = false;
		server = http2.createServer();
		server.on("stream", (stream, headers) => {
			authorized = headers.authorization === "Bearer fixture-access";
			stream.on("data", () => {});
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			const ended = create(AgentServerMessageSchema, {
				message: {
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				},
			});
			stream.end(frame(toBinary(AgentServerMessageSchema, ended)));
		});
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("bind failed");
		process.env.CURSOR_AGENT_TOKEN = "fixture-access";
		const stream = streamCursor(model(`http://127.0.0.1:${address.port}`), context, {
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
		});
		expect((await stream.result()).stopReason).toBe("stop");
		expect(authorized).toBe(true);
	});

	it("does not borrow CURSOR_TOKEN or the cloud CURSOR_API_KEY", async () => {
		process.env.CURSOR_TOKEN = "wrong-local-token";
		process.env.CURSOR_API_KEY = "wrong-cloud-key";
		const stream = streamCursor(model("https://unused.invalid"), context, {
			discoveredModelIds: new Set(["cursor-grok-4.5-high"]),
		});
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/access token.*required/i);
		delete process.env.CURSOR_TOKEN;
		delete process.env.CURSOR_API_KEY;
	});
});

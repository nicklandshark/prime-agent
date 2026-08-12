import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { GetUsableModelsResponseSchema, ModelDetailsSchema } from "../src/providers/cursor-not-cloud/agent_pb.js";
import {
	CURSOR_DISCOVERY_FRESH_TTL_MS,
	CursorDiscoveryError,
	clearCursorAgentDiscoveryCache,
	fetchCursorAgentModelIds,
	getCursorAgentModelCatalog,
	validateCursorAgentRoute,
} from "../src/providers/cursor-not-cloud/discovery.js";

type Reply = {
	status?: number;
	contentType?: string;
	body?: Uint8Array;
	trailers?: http2.OutgoingHttpHeaders;
	hang?: boolean;
};
let server: http2.Http2Server | undefined;
let reply: Reply = {};
let requests = 0;

function frame(body: Uint8Array, flags = 0): Uint8Array {
	const result = Buffer.alloc(5 + body.length);
	result[0] = flags;
	result.writeUInt32BE(body.length, 1);
	result.set(body, 5);
	return result;
}

function catalog(...ids: string[]): Uint8Array {
	return toBinary(
		GetUsableModelsResponseSchema,
		create(GetUsableModelsResponseSchema, {
			models: ids.map((modelId) => create(ModelDetailsSchema, { modelId })),
		}),
	);
}

async function startServer(): Promise<string> {
	server = http2.createServer();
	server.on("stream", (stream) => {
		requests++;
		stream.on("data", () => {});
		if (reply.hang) return;
		const headers = {
			":status": reply.status ?? 200,
			"content-type": reply.contentType ?? "application/proto",
		};
		if (reply.trailers) {
			stream.respond(headers, { waitForTrailers: true });
			stream.on("wantTrailers", () => stream.sendTrailers(reply.trailers!));
		} else {
			stream.respond(headers);
		}
		stream.end(reply.body ?? catalog("cursor-grok-4.5-high"));
	});
	await new Promise<void>((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture bind failed");
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	clearCursorAgentDiscoveryCache();
	requests = 0;
	if (!server) return;
	const current = server;
	server = undefined;
	await new Promise<void>((resolve) => current.close(() => resolve()));
});

describe("cursor-not-cloud discovery", () => {
	it("decodes raw protobuf, Connect unary, successful empty, and partial route catalogs", async () => {
		const baseUrl = await startServer();
		reply = { body: catalog("cursor-grok-4.5-low", "cursor-grok-4.6-xhigh-fast") };
		expect(await fetchCursorAgentModelIds("fixture-a", { baseUrl })).toEqual(
			new Set(["cursor-grok-4.5-low", "cursor-grok-4.6-xhigh-fast"]),
		);
		reply = {
			contentType: "application/connect+proto",
			body: Buffer.concat([frame(catalog("cursor-grok-4.5-medium-fast")), frame(Buffer.from("{}"), 2)]),
		};
		expect(await fetchCursorAgentModelIds("fixture-a", { baseUrl })).toEqual(
			new Set(["cursor-grok-4.5-medium-fast"]),
		);
		reply = { body: catalog() };
		expect(await fetchCursorAgentModelIds("fixture-a", { baseUrl })).toEqual(new Set());
	});

	it.each([
		["non-2xx", { status: 503 }, "http"],
		["wrong content type", { contentType: "text/plain", body: catalog() }, "content-type"],
		["malformed protobuf", { body: new Uint8Array([0xff]) }, "decode"],
		["compressed Connect", { contentType: "application/connect+proto", body: frame(catalog(), 1) }, "compressed"],
		["missing Connect end", { contentType: "application/connect+proto", body: frame(catalog()) }, "truncated"],
		[
			"duplicate Connect end",
			{
				contentType: "application/connect+proto",
				body: Buffer.concat([frame(catalog()), frame(Buffer.from("{}"), 2), frame(Buffer.from("{}"), 2)]),
			},
			"decode",
		],
		[
			"out-of-order Connect end",
			{
				contentType: "application/connect+proto",
				body: Buffer.concat([frame(Buffer.from("{}"), 2), frame(catalog())]),
			},
			"decode",
		],
		[
			"malformed Connect end shape",
			{
				contentType: "application/connect+proto",
				body: Buffer.concat([frame(catalog()), frame(Buffer.from("[]"), 2)]),
			},
			"decode",
		],
		[
			"truncated Connect",
			{ contentType: "application/connect+proto", body: new Uint8Array([0, 0, 0, 0, 4, 1]) },
			"truncated",
		],
		["oversized body", { body: new Uint8Array(8 * 1024 * 1024 + 1) }, "oversized"],
		["bad trailers", { body: catalog(), trailers: { "grpc-status": "13" } }, "trailers"],
	] as const)("rejects %s distinctly", async (_name, fixture, kind) => {
		reply = fixture;
		const baseUrl = await startServer();
		await expect(fetchCursorAgentModelIds("fixture-b", { baseUrl })).rejects.toMatchObject({ kind });
	});

	it("bounds timeout and preserves sanitized error shape", async () => {
		reply = { hang: true };
		const baseUrl = await startServer();
		await expect(fetchCursorAgentModelIds("fixture-c", { baseUrl, timeoutMs: 20 })).rejects.toMatchObject({
			name: "CursorDiscoveryError",
			kind: "timeout",
		});
	});

	it("keys cache by credential and uses stale LKG only for transient failure", async () => {
		const baseUrl = await startServer();
		reply = { body: catalog("cursor-grok-4.5-high") };
		const first = await getCursorAgentModelCatalog("fixture-d1", { baseUrl, now: 1 });
		expect(first.stale).toBe(false);
		reply = { status: 503 };
		const fresh = await getCursorAgentModelCatalog("fixture-d1", { baseUrl, now: 2 });
		expect(fresh).toStrictEqual(first);
		expect(requests).toBe(1);
		const stale = await getCursorAgentModelCatalog("fixture-d1", {
			baseUrl,
			now: 1 + CURSOR_DISCOVERY_FRESH_TTL_MS + 1,
		});
		expect(stale).toMatchObject({ stale: true });
		expect(stale.modelIds).toEqual(new Set(["cursor-grok-4.5-high"]));
		await expect(
			getCursorAgentModelCatalog("fixture-d2", { baseUrl, now: 1 + CURSOR_DISCOVERY_FRESH_TTL_MS + 1 }),
		).rejects.toBeInstanceOf(CursorDiscoveryError);
	});

	it.each([408, 425, 429, 500, 503])("uses stale LKG for transient HTTP %i but never 401/403", async (status) => {
		const baseUrl = await startServer();
		const token = `fixture-transient-${status}`;
		reply = { body: catalog("cursor-grok-4.5-high") };
		await getCursorAgentModelCatalog(token, { baseUrl, now: 1 });
		reply = { status };
		await expect(
			getCursorAgentModelCatalog(token, { baseUrl, now: 1 + CURSOR_DISCOVERY_FRESH_TTL_MS + 1 }),
		).resolves.toMatchObject({ stale: true });
	});

	it.each([401, 403])("does not use stale LKG for auth HTTP %i", async (status) => {
		const baseUrl = await startServer();
		const token = `fixture-auth-${status}`;
		reply = { body: catalog("cursor-grok-4.5-high") };
		await getCursorAgentModelCatalog(token, { baseUrl, now: 1 });
		reply = { status };
		await expect(
			getCursorAgentModelCatalog(token, { baseUrl, now: 1 + CURSOR_DISCOVERY_FRESH_TTL_MS + 1 }),
		).rejects.toMatchObject({ status });
	});

	it("replaces old entitlement with a successful empty catalog", async () => {
		const baseUrl = await startServer();
		reply = { body: catalog("cursor-grok-4.5-high") };
		await getCursorAgentModelCatalog("fixture-e", { baseUrl, now: 1 });
		reply = { body: catalog() };
		const changed = await getCursorAgentModelCatalog("fixture-e", {
			baseUrl,
			now: 1 + CURSOR_DISCOVERY_FRESH_TTL_MS + 1,
		});
		expect(changed).toMatchObject({ stale: false });
		expect(changed.modelIds.size).toBe(0);
	});

	it("validates the final selected normal or fast route without substitution", async () => {
		await validateCursorAgentRoute("fixture-f", "cursor-grok-4.5-low", {
			modelIds: new Set(["cursor-grok-4.5-low"]),
		});
		await validateCursorAgentRoute("fixture-f", "cursor-grok-4.6-xhigh-fast", {
			modelIds: new Set(["cursor-grok-4.6-xhigh-fast"]),
		});
		await expect(
			validateCursorAgentRoute("fixture-f", "cursor-grok-4.5-low-fast", {
				modelIds: new Set(["cursor-grok-4.5-low"]),
			}),
		).rejects.toMatchObject({ kind: "capability" });
	});
});

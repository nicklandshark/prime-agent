import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./agent_pb.js";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "./compat.js";
import { CURSOR_API_URL, CURSOR_CLIENT_VERSION } from "./index.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

export const CURSOR_GROK_45_ROUTE_IDS = [
	"cursor-grok-4.5-low",
	"cursor-grok-4.5-low-fast",
	"cursor-grok-4.5-medium",
	"cursor-grok-4.5-medium-fast",
	"cursor-grok-4.5-high",
	"cursor-grok-4.5-high-fast",
] as const;

export const CURSOR_KIMI_K3_ROUTE_IDS = ["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"] as const;

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | undefined {
	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset] ?? 0;
		const length = new DataView(payload.buffer, payload.byteOffset + offset + 1, 4).getUint32(0, false);
		const end = offset + 5 + length;
		if (end > payload.length || (flags & 1) !== 0) return undefined;
		if ((flags & 2) === 0) return payload.subarray(offset + 5, end);
		offset = end;
	}
	return undefined;
}

async function requestCatalog(
	apiKey: string,
	options: { baseUrl?: string; clientVersion?: string; timeoutMs?: number },
): Promise<Uint8Array> {
	const baseUrl = (options.baseUrl ?? CURSOR_API_URL).replace(/\/+$/, "");
	const body = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, { customModelIds: [] }));
	const proxyUrl = getProxyForProvider("cursor-agent");
	const proxiedSocket =
		proxyUrl && !shouldBypassProxy(new URL(baseUrl))
			? await connectProxiedSocket(proxyUrl, baseUrl, { timeoutMs: options.timeoutMs ?? 5_000 })
			: undefined;
	return new Promise<Uint8Array>((resolve, reject) => {
		const client = http2.connect(baseUrl, proxiedSocket ? { createConnection: () => proxiedSocket } : undefined);
		let settled = false;
		const finish = (error?: unknown, value?: Uint8Array) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.close();
			if (error) reject(error);
			else resolve(value ?? new Uint8Array());
		};
		const timer = setTimeout(() => {
			client.destroy();
			finish(new Error("Cursor model discovery timed out"));
		}, options.timeoutMs ?? 5_000);
		client.once("error", finish);
		const request = client.request({
			":method": "POST",
			":path": GET_USABLE_MODELS_PATH,
			"content-type": "application/proto",
			te: "trailers",
			authorization: `Bearer ${apiKey}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": options.clientVersion ?? CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
		});
		const chunks: Buffer[] = [];
		request.on("response", (headers) => {
			const status = Number(headers[":status"] ?? 0);
			if (status < 200 || status >= 300) finish(new Error(`Cursor model discovery failed with HTTP ${status}`));
		});
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.once("error", finish);
		request.once("end", () => finish(undefined, new Uint8Array(Buffer.concat(chunks))));
		request.end(Buffer.from(body));
	});
}

/** Fetch the credential-gated current Cursor wire-model IDs. */
export async function fetchCursorAgentModelIds(
	apiKey: string,
	options: { baseUrl?: string; clientVersion?: string; timeoutMs?: number } = {},
): Promise<Set<string>> {
	const payload = await requestCatalog(apiKey, options);
	const body = decodeConnectUnaryBody(payload) ?? payload;
	const decoded = fromBinary(GetUsableModelsResponseSchema, body);
	return new Set(decoded.models.map((model) => model.modelId).filter((id) => id.length > 0));
}

export function hasCursorAgentLogicalModelRoutes(logicalModelId: string, modelIds: ReadonlySet<string>): boolean {
	const required =
		logicalModelId === "cursor-grok-4.5-high"
			? CURSOR_GROK_45_ROUTE_IDS
			: logicalModelId === "kimi-k3-max"
				? CURSOR_KIMI_K3_ROUTE_IDS
				: [];
	return required.length > 0 && required.every((id) => modelIds.has(id));
}

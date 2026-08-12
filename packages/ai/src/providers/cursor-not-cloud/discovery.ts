import { createHash } from "node:crypto";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "./agent_pb.js";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "./compat.js";
import { CURSOR_API_URL, normalizeCursorOrigin, resolveCursorClientVersion } from "./config.js";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CONNECT_FRAME_BYTES = 32 * 1024 * 1024;
export const CURSOR_DISCOVERY_FRESH_TTL_MS = 5 * 60 * 1_000;
export const CURSOR_DISCOVERY_STALE_TTL_MS = 24 * 60 * 60 * 1_000;

export const CURSOR_GROK_45_NORMAL_ROUTE_IDS = [
	"cursor-grok-4.5-low",
	"cursor-grok-4.5-medium",
	"cursor-grok-4.5-high",
] as const;
export const CURSOR_GROK_45_FAST_ROUTE_IDS = [
	"cursor-grok-4.5-low-fast",
	"cursor-grok-4.5-medium-fast",
	"cursor-grok-4.5-high-fast",
] as const;
export const CURSOR_GROK_45_ROUTE_IDS = [...CURSOR_GROK_45_NORMAL_ROUTE_IDS, ...CURSOR_GROK_45_FAST_ROUTE_IDS] as const;

export const CURSOR_GROK_46_NORMAL_ROUTE_IDS = [
	"cursor-grok-4.6-low",
	"cursor-grok-4.6-medium",
	"cursor-grok-4.6-high",
	"cursor-grok-4.6-xhigh",
] as const;
export const CURSOR_GROK_46_FAST_ROUTE_IDS = [
	"cursor-grok-4.6-low-fast",
	"cursor-grok-4.6-medium-fast",
	"cursor-grok-4.6-high-fast",
	"cursor-grok-4.6-xhigh-fast",
] as const;
export const CURSOR_GROK_46_ROUTE_IDS = [...CURSOR_GROK_46_NORMAL_ROUTE_IDS, ...CURSOR_GROK_46_FAST_ROUTE_IDS] as const;

export const CURSOR_GROK_NORMAL_ROUTE_IDS = [
	...CURSOR_GROK_45_NORMAL_ROUTE_IDS,
	...CURSOR_GROK_46_NORMAL_ROUTE_IDS,
] as const;
export const CURSOR_GROK_FAST_ROUTE_IDS = [...CURSOR_GROK_45_FAST_ROUTE_IDS, ...CURSOR_GROK_46_FAST_ROUTE_IDS] as const;
export const CURSOR_GROK_ROUTE_IDS = [...CURSOR_GROK_NORMAL_ROUTE_IDS, ...CURSOR_GROK_FAST_ROUTE_IDS] as const;

export type CursorDiscoveryErrorKind =
	| "timeout"
	| "network"
	| "http"
	| "content-type"
	| "trailers"
	| "compressed"
	| "oversized"
	| "truncated"
	| "decode"
	| "capability";

export class CursorDiscoveryError extends Error {
	readonly transient: boolean;
	constructor(
		message: string,
		readonly kind: CursorDiscoveryErrorKind,
		readonly status?: number,
	) {
		super(message);
		this.name = "CursorDiscoveryError";
		this.transient =
			kind === "timeout" ||
			kind === "network" ||
			(kind === "http" && ([408, 425, 429].includes(status ?? 0) || (status ?? 0) >= 500));
	}
}

type DiscoveryOptions = {
	baseUrl?: string;
	clientVersion?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};

type RawCatalogResponse = { payload: Uint8Array; contentType: string };

function normalizeBaseUrl(baseUrl?: string): string {
	return normalizeCursorOrigin(baseUrl ?? CURSOR_API_URL);
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array {
	let offset = 0;
	let dataFrame: Uint8Array | undefined;
	let sawEnd = false;
	while (offset < payload.length) {
		if (sawEnd)
			throw new CursorDiscoveryError("Cursor catalog sent a frame after its Connect end envelope", "decode");
		if (payload.length - offset < 5)
			throw new CursorDiscoveryError("Cursor catalog ended with a partial Connect header", "truncated");
		const flags = payload[offset] ?? 0;
		if ((flags & 1) !== 0)
			throw new CursorDiscoveryError("Compressed Cursor catalog frames are unsupported", "compressed");
		if (flags !== 0 && flags !== 2)
			throw new CursorDiscoveryError("Cursor catalog used unknown Connect frame flags", "decode");
		const length = new DataView(payload.buffer, payload.byteOffset + offset + 1, 4).getUint32(0, false);
		if (length > MAX_CONNECT_FRAME_BYTES)
			throw new CursorDiscoveryError("Cursor catalog frame exceeded 32 MiB", "oversized");
		const end = offset + 5 + length;
		if (end > payload.length)
			throw new CursorDiscoveryError("Cursor catalog ended with a partial Connect frame", "truncated");
		const body = payload.subarray(offset + 5, end);
		if (flags === 2) {
			if (!dataFrame)
				throw new CursorDiscoveryError("Cursor catalog end envelope arrived before unary data", "decode");
			sawEnd = true;
			let envelope: unknown;
			try {
				envelope = JSON.parse(new TextDecoder().decode(body));
			} catch {
				throw new CursorDiscoveryError("Cursor catalog end envelope was malformed", "decode");
			}
			if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
				throw new CursorDiscoveryError("Cursor catalog end envelope had an invalid shape", "decode");
			}
			const error = (envelope as { error?: unknown }).error;
			if (error !== undefined) {
				if (!error || typeof error !== "object" || Array.isArray(error))
					throw new CursorDiscoveryError("Cursor catalog end error had an invalid shape", "decode");
				throw new CursorDiscoveryError(
					`Cursor model discovery returned Connect error ${String((error as { code?: unknown }).code ?? "unknown")}`,
					"http",
				);
			}
		} else {
			if (dataFrame) throw new CursorDiscoveryError("Cursor catalog returned multiple unary data frames", "decode");
			dataFrame = body;
		}
		offset = end;
	}
	if (!dataFrame) throw new CursorDiscoveryError("Cursor catalog Connect response had no data frame", "decode");
	if (!sawEnd) throw new CursorDiscoveryError("Cursor catalog Connect response had no end envelope", "truncated");
	return dataFrame;
}

async function requestCatalog(apiKey: string, options: DiscoveryOptions): Promise<RawCatalogResponse> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const timeoutMs = options.timeoutMs ?? 5_000;
	const clientVersion = resolveCursorClientVersion(options.clientVersion);
	const body = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, { customModelIds: [] }));
	const proxyUrl = getProxyForProvider("cursor-not-cloud");
	const proxiedSocket =
		proxyUrl && !shouldBypassProxy(new URL(baseUrl))
			? await connectProxiedSocket(proxyUrl, baseUrl, { timeoutMs, signal: options.signal })
			: undefined;
	return new Promise<RawCatalogResponse>((resolve, reject) => {
		let client: http2.ClientHttp2Session;
		try {
			client = http2.connect(baseUrl, proxiedSocket ? { createConnection: () => proxiedSocket } : undefined);
		} catch {
			reject(new CursorDiscoveryError("Cursor model discovery could not open HTTP/2", "network"));
			return;
		}
		let settled = false;
		let responseStatus = 0;
		let contentType = "";
		let totalBytes = 0;
		const chunks: Buffer[] = [];
		const finish = (error?: unknown, value?: RawCatalogResponse) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			client.close();
			if (error) reject(error);
			else resolve(value ?? { payload: new Uint8Array(), contentType });
		};
		const onAbort = () => {
			client.destroy();
			finish(options.signal?.reason ?? new CursorDiscoveryError("Cursor model discovery was aborted", "network"));
		};
		const timer = setTimeout(() => {
			client.destroy();
			finish(new CursorDiscoveryError("Cursor model discovery timed out", "timeout"));
		}, timeoutMs);
		client.once("error", () =>
			finish(new CursorDiscoveryError("Cursor model discovery transport failed", "network")),
		);
		if (options.signal?.aborted) return onAbort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const request = client.request({
			":method": "POST",
			":path": GET_USABLE_MODELS_PATH,
			"content-type": "application/proto",
			te: "trailers",
			authorization: `Bearer ${apiKey}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": clientVersion,
			"x-cursor-client-type": "cli",
		});
		request.on("response", (headers) => {
			responseStatus = Number(headers[":status"] ?? 0);
			contentType = String(headers["content-type"] ?? "")
				.split(";", 1)[0]!
				.trim()
				.toLowerCase();
			if (responseStatus < 200 || responseStatus >= 300) {
				request.close();
				finish(
					new CursorDiscoveryError(
						`Cursor model discovery failed with HTTP ${responseStatus}`,
						"http",
						responseStatus,
					),
				);
			}
		});
		request.on("trailers", (trailers) => {
			const status = String(trailers["grpc-status"] ?? "0");
			if (status !== "0")
				finish(new CursorDiscoveryError(`Cursor model discovery trailers reported status ${status}`, "trailers"));
		});
		request.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes > MAX_CATALOG_BYTES) {
				request.close();
				finish(new CursorDiscoveryError("Cursor model catalog exceeded 8 MiB", "oversized"));
				return;
			}
			chunks.push(chunk);
		});
		request.once("error", () => finish(new CursorDiscoveryError("Cursor model discovery request failed", "network")));
		request.once("end", () => {
			if (settled) return;
			if (responseStatus < 200 || responseStatus >= 300) return;
			const allowed = ["application/proto", "application/protobuf", "application/connect+proto"];
			if (!allowed.includes(contentType)) {
				finish(
					new CursorDiscoveryError(
						`Cursor catalog returned unsupported content type ${contentType || "<missing>"}`,
						"content-type",
					),
				);
				return;
			}
			finish(undefined, { payload: new Uint8Array(Buffer.concat(chunks)), contentType });
		});
		request.end(Buffer.from(body));
	});
}

/** Fetch the credential-gated current Cursor wire-model IDs. Empty success is distinct from failure. */
export async function fetchCursorAgentModelIds(apiKey: string, options: DiscoveryOptions = {}): Promise<Set<string>> {
	const response = await requestCatalog(apiKey, options);
	const body =
		response.contentType === "application/connect+proto"
			? decodeConnectUnaryBody(response.payload)
			: response.payload;
	try {
		const decoded = fromBinary(GetUsableModelsResponseSchema, body);
		return new Set(decoded.models.map((model) => model.modelId).filter((id) => id.length > 0));
	} catch {
		throw new CursorDiscoveryError("Cursor model catalog protobuf could not be decoded", "decode");
	}
}

type CachedCatalog = { modelIds: Set<string>; refreshedAt: number };
const catalogCache = new Map<string, CachedCatalog>();

function cacheKey(apiKey: string, options: DiscoveryOptions): string {
	const values = [
		createHash("sha256").update(apiKey).digest("hex"),
		normalizeBaseUrl(options.baseUrl),
		resolveCursorClientVersion(options.clientVersion),
	];
	const hash = createHash("sha256");
	for (const value of values) hash.update(`${Buffer.byteLength(value)}:`).update(value);
	return hash.digest("hex");
}

export async function getCursorAgentModelCatalog(
	apiKey: string,
	options: DiscoveryOptions & { now?: number } = {},
): Promise<{ modelIds: Set<string>; stale: boolean; refreshedAt: number }> {
	const now = options.now ?? Date.now();
	const key = cacheKey(apiKey, options);
	const cached = catalogCache.get(key);
	if (cached && now - cached.refreshedAt < CURSOR_DISCOVERY_FRESH_TTL_MS) {
		return { modelIds: new Set(cached.modelIds), stale: false, refreshedAt: cached.refreshedAt };
	}
	try {
		const modelIds = await fetchCursorAgentModelIds(apiKey, options);
		const next = { modelIds: new Set(modelIds), refreshedAt: now };
		catalogCache.set(key, next);
		return { modelIds, stale: false, refreshedAt: now };
	} catch (error) {
		if (
			error instanceof CursorDiscoveryError &&
			error.transient &&
			cached &&
			now - cached.refreshedAt < CURSOR_DISCOVERY_STALE_TTL_MS
		) {
			return { modelIds: new Set(cached.modelIds), stale: true, refreshedAt: cached.refreshedAt };
		}
		throw error;
	}
}

export function clearCursorAgentDiscoveryCache(): void {
	catalogCache.clear();
}

/** A logical Grok remains visible when any normal reasoning route in its own family is entitled. */
export function hasCursorAgentLogicalModelRoutes(logicalModelId: string, modelIds: ReadonlySet<string>): boolean {
	const routes =
		logicalModelId === "cursor-grok-4.5-high"
			? CURSOR_GROK_45_NORMAL_ROUTE_IDS
			: logicalModelId === "cursor-grok-4.6-high"
				? CURSOR_GROK_46_NORMAL_ROUTE_IDS
				: undefined;
	return routes?.some((id) => modelIds.has(id)) ?? false;
}

export async function validateCursorAgentRoute(
	apiKey: string,
	routeId: string,
	options: DiscoveryOptions & { modelIds?: ReadonlySet<string> } = {},
): Promise<void> {
	const modelIds = options.modelIds ?? (await getCursorAgentModelCatalog(apiKey, options)).modelIds;
	if (!modelIds.has(routeId)) {
		throw new CursorDiscoveryError(
			`Cursor route ${routeId} is unavailable for the active subscription. Disable fast or choose an available reasoning level.`,
			"capability",
		);
	}
}

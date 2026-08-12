import { createHash } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import { stripVTControlCharacters } from "node:util";
import type { Model, Tool } from "../../types.js";
import { parseStreamingJson } from "../../utils/json-parse.js";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.js";

export const $env = process.env;

export const logger = {
	warn(message: string, data?: unknown): void {
		console.warn(message, data ?? "");
	},
};

export { parseJsonWithRepair, parseStreamingJson } from "../../utils/json-parse.js";

export function parseStreamingJsonThrottled<T = Record<string, unknown>>(
	partialJson: string | undefined,
	lastParsedLen: number,
	minGrowthBytes = 64,
): { value: T; parsedLen: number } | null {
	const len = partialJson?.length ?? 0;
	if (len === 0 || (lastParsedLen > 0 && len - lastParsedLen < minGrowthBytes)) return null;
	return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}

const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
export function sanitizeText(text: string): string {
	const wellFormed = sanitizeSurrogates(text);
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(wellFormed) === null) return wellFormed;
	const stripped = wellFormed.includes("\x1b") ? stripVTControlCharacters(wellFormed) : wellFormed;
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

export function normalizeSystemPrompts(value: string | readonly string[] | undefined): string[] {
	if (typeof value === "string") return value.trim().length > 0 ? [value] : [];
	return value?.filter((prompt) => prompt.trim().length > 0) ?? [];
}

export function deterministicUuid(seed: string): `${string}-${string}-${string}-${string}-${string}` {
	const hex = createHash("sha256").update(seed).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function toolWireSchema(tool: Tool): Record<string, unknown> {
	return tool.parameters as unknown as Record<string, unknown>;
}

export function isCursorGrokRouteId(modelId: string): boolean {
	return /^cursor-grok-4\.(?:5-(?:low|medium|high)|6-(?:low|medium|high|xhigh))(?:-fast)?$/.test(modelId);
}

/** Canonical logical-family key shared by a Grok release's reasoning and fast sibling routes. */
export function canonicalCursorGrokModelId(modelId: string): string {
	const match = /^cursor-grok-(4\.(?:5|6))-/.exec(modelId);
	return match && isCursorGrokRouteId(modelId) ? `cursor-grok-${match[1]}` : modelId;
}

function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();
	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}
	const ip = lowerHost.replace(/^\[|\]$/g, "");
	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		return (
			a === 127 ||
			a === 10 ||
			a === 0 ||
			(a === 169 && b === 254) ||
			(a === 192 && b === 168) ||
			(a === 172 && b >= 16 && b <= 31)
		);
	}
	return ip === "::1" || ip === "::" || /^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip);
}

export function shouldBypassProxy(url: URL): boolean {
	if (isLocalOrMetadataHost(url.hostname)) return true;
	const noProxy = process.env.NO_PROXY || process.env.no_proxy;
	if (!noProxy) return false;
	const targetHost = url.hostname.toLowerCase();
	const targetPort = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
	for (const rawRule of noProxy.split(/[,\s]+/)) {
		if (!rawRule) continue;
		if (rawRule === "*") return true;
		let rule = rawRule.toLowerCase();
		let port: string | undefined;
		if (rule.includes("]:")) {
			const colon = rule.lastIndexOf(":");
			port = rule.slice(colon + 1);
			rule = rule.slice(0, colon);
		} else if (!rule.includes("]") && rule.includes(":")) {
			const colon = rule.lastIndexOf(":");
			port = rule.slice(colon + 1);
			rule = rule.slice(0, colon);
		}
		if (port && port !== targetPort) continue;
		rule = rule.replace(/^\[|\]$/g, "");
		const suffix = rule.startsWith(".") ? rule : `.${rule}`;
		const bare = rule.startsWith(".") ? rule.slice(1) : rule;
		if (targetHost === bare || targetHost.endsWith(suffix)) return true;
	}
	return false;
}

const proxyCache = new Map<string, string | undefined>();
export function getProxyForProvider(provider: Model<any>["provider"]): string | undefined {
	if (proxyCache.has(provider)) return proxyCache.get(provider);
	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const value = process.env[`PI_PROXY_${normalized}`] || process.env.PI_PROXY;
	proxyCache.set(provider, value);
	return value;
}

/** Establish a TLS/HTTP2 socket through an HTTP CONNECT proxy. */
export async function connectProxiedSocket(
	proxyUrlString: string,
	targetUrlString: string,
	options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<tls.TLSSocket> {
	if (options.signal?.aborted) throw new Error("Proxy tunnel aborted");
	const proxyUrl = new URL(proxyUrlString);
	const targetUrl = new URL(targetUrlString);
	const secureProxy = proxyUrl.protocol === "https:";
	if (!secureProxy && proxyUrl.protocol !== "http:") {
		throw new Error(`Unsupported Cursor proxy protocol: ${proxyUrl.protocol}`);
	}
	const proxyPort = Number(proxyUrl.port || (secureProxy ? 443 : 80));
	const targetPort = Number(targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443));
	const targetHost = targetUrl.hostname;

	return await new Promise<tls.TLSSocket>((resolve, reject) => {
		let rawSocket: net.Socket | tls.TLSSocket | undefined;
		let tunnelSocket: tls.TLSSocket | undefined;
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		const responseChunks: Buffer[] = [];
		let responseBytes = 0;
		let delimiterTail = Buffer.alloc(0);
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			tunnelSocket?.destroy();
			rawSocket?.destroy();
			reject(error);
		};
		const succeed = () => {
			if (settled || !tunnelSocket) return;
			settled = true;
			cleanup();
			resolve(tunnelSocket);
		};
		const onAbort = () => fail(new Error("Proxy tunnel aborted"));
		const onProxyData = (chunk: Buffer) => {
			try {
				if (!rawSocket) return;
				responseBytes += chunk.byteLength;
				if (responseBytes > 64 * 1024) {
					fail(new Error("Proxy CONNECT response header exceeded 64 KiB"));
					return;
				}
				responseChunks.push(chunk);
				const scan = delimiterTail.length > 0 ? Buffer.concat([delimiterTail, chunk]) : chunk;
				const localEnd = scan.indexOf("\r\n\r\n");
				delimiterTail = Buffer.from(scan.subarray(Math.max(0, scan.length - 3)));
				if (localEnd < 0) return;
				rawSocket.off("data", onProxyData);
				const response = Buffer.concat(responseChunks, responseBytes);
				const headerEnd = response.indexOf("\r\n\r\n");
				if (headerEnd < 0) {
					fail(new Error("Proxy CONNECT response header was malformed"));
					return;
				}
				const statusLine = response.subarray(0, headerEnd).toString("latin1").split("\r\n", 1)[0];
				if (!/^HTTP\/1\.[01] 200(?: |$)/.test(statusLine)) {
					fail(new Error(`Proxy tunnel failed: ${statusLine}`));
					return;
				}
				tunnelSocket = tls.connect({ socket: rawSocket, servername: targetHost, ALPNProtocols: ["h2"] });
				tunnelSocket.once("secureConnect", succeed);
				tunnelSocket.once("error", fail);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onProxyReady = () => {
			try {
				if (!rawSocket) return;
				let request = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
				if (proxyUrl.username || proxyUrl.password) {
					const credentials = Buffer.from(
						`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
					).toString("base64");
					request += `Proxy-Authorization: Basic ${credentials}\r\n`;
				}
				rawSocket.write(`${request}\r\n`);
				rawSocket.on("data", onProxyData);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs && options.timeoutMs > 0) {
			timer = setTimeout(
				() => fail(new Error(`Proxy tunnel timed out after ${options.timeoutMs}ms`)),
				options.timeoutMs,
			);
			timer.unref?.();
		}
		rawSocket = secureProxy
			? tls.connect({ host: proxyUrl.hostname, port: proxyPort })
			: net.connect({ host: proxyUrl.hostname, port: proxyPort });
		rawSocket.once("error", fail);
		rawSocket.once(secureProxy ? "secureConnect" : "connect", onProxyReady);
	});
}

export interface RequestDebugResponseLog {
	write(chunk: Uint8Array | string): void;
	close(): Promise<void>;
}
interface RequestDebugSession {
	openResponseLog(statusLine: string, headers?: unknown): Promise<RequestDebugResponseLog>;
}
export function isRequestDebugEnabled(): boolean {
	return false;
}
export async function createRequestDebugSession(_payload: unknown): Promise<RequestDebugSession> {
	const log: RequestDebugResponseLog = { write() {}, async close() {} };
	return {
		async openResponseLog() {
			return log;
		},
	};
}

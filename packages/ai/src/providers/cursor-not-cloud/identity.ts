import { normalizeCursorOrigin } from "./config.js";

const GET_ME_PATH = "/aiserver.v1.DashboardService/GetMe";
const MAX_IDENTITY_BYTES = 64 * 1024;

export type CursorAccountIdentity = { email?: string; authId?: string; userId?: string };
export type CursorIdentityErrorKind = "timeout" | "abort" | "http" | "decode" | "oversized" | "network";

export class CursorIdentityError extends Error {
	constructor(
		message: string,
		readonly kind: CursorIdentityErrorKind,
		readonly status?: number,
	) {
		super(message);
		this.name = "CursorIdentityError";
	}
}

function boundedString(value: unknown, maxLength = 512): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

async function readBoundedIdentityBody(response: Response): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_IDENTITY_BYTES) {
				await reader.cancel("identity response exceeded limit");
				throw new CursorIdentityError("Cursor identity response was too large", "oversized");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Bounded JSON Connect identity RPC. The token and raw response never enter errors or returned data. */
export async function fetchCursorAccountIdentity(
	accessToken: string,
	options: { baseUrl?: string; timeoutMs?: number; signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<CursorAccountIdentity> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new CursorIdentityError("Cursor identity request timed out", "timeout")),
		options.timeoutMs ?? 5_000,
	);
	const onAbort = () => controller.abort(new CursorIdentityError("Cursor identity request was aborted", "abort"));
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const fetchImpl = options.fetch ?? globalThis.fetch;
		let response: Response;
		try {
			response = await fetchImpl(new URL(GET_ME_PATH, normalizeCursorOrigin(options.baseUrl)), {
				method: "POST",
				headers: {
					authorization: `Bearer ${accessToken}`,
					"content-type": "application/json",
					"connect-protocol-version": "1",
					"x-cursor-client-type": "cli",
				},
				body: "{}",
				signal: controller.signal,
			});
		} catch {
			if (controller.signal.reason instanceof CursorIdentityError) throw controller.signal.reason;
			throw new CursorIdentityError("Cursor identity request failed", "network");
		}
		if (!response.ok) {
			throw new CursorIdentityError(
				`Cursor identity request failed with HTTP ${response.status}`,
				"http",
				response.status,
			);
		}
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (contentType !== "application/json") {
			throw new CursorIdentityError("Cursor identity response had an unsupported content type", "decode");
		}
		const declaredLength = Number(response.headers.get("content-length") ?? 0);
		if (declaredLength > MAX_IDENTITY_BYTES)
			throw new CursorIdentityError("Cursor identity response was too large", "oversized");
		const bytes = await readBoundedIdentityBody(response);
		let payload: unknown;
		try {
			payload = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new CursorIdentityError("Cursor identity response was malformed", "decode");
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new CursorIdentityError("Cursor identity response had an invalid shape", "decode");
		}
		const record = payload as Record<string, unknown>;
		const email = boundedString(record.email, 320);
		const authId = boundedString(record.authId);
		const userId = boundedString(record.userId);
		return {
			...(email ? { email } : {}),
			...(authId ? { authId } : {}),
			...(userId ? { userId } : {}),
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

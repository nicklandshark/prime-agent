import { extractStreamFailureInfo, formatStreamFailureMessage } from "../../utils/stream-failure.js";

export class ProviderResponseError extends Error {
	readonly details?: Record<string, unknown>;
	readonly status?: number;
	readonly code?: string;
	constructor(message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ProviderResponseError";
		this.details = details;
		this.status = typeof details?.status === "number" ? details.status : undefined;
		this.code = typeof details?.kind === "string" ? details.kind : undefined;
	}
}

export class MissingApiKeyError extends Error {
	constructor(_provider?: string, message = "API key is required") {
		super(message);
		this.name = "MissingApiKeyError";
	}
}

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

export class AbortError extends Error {
	constructor(message = "Request was aborted") {
		super(message);
		this.name = "AbortError";
	}
}

export async function finalize(
	error: unknown,
	options: { api?: string; signal?: AbortSignal },
): Promise<{ stopReason: "aborted" | "error"; status?: number; id?: string; message: string }> {
	const aborted = options.signal?.aborted === true || error instanceof AbortError;
	if (aborted) return { stopReason: "aborted", message: error instanceof Error ? error.message : String(error) };
	const info = extractStreamFailureInfo(error);
	return {
		stopReason: "error",
		...(info.status !== undefined ? { status: info.status } : {}),
		...(info.requestId ? { id: info.requestId } : {}),
		message: formatStreamFailureMessage(error),
	};
}

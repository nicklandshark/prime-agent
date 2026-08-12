export class ProviderResponseError extends Error {
	readonly details?: Record<string, unknown>;
	constructor(message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ProviderResponseError";
		this.details = details;
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
	return {
		stopReason: aborted ? "aborted" : "error",
		message: error instanceof Error ? error.message : String(error),
	};
}

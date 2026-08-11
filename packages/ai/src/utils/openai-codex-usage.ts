/**
 * OpenAI Codex (ChatGPT subscription) usage probing.
 *
 * Two data sources:
 * - The wham/usage endpoint (authoritative; plan type, allowed flag, window
 *   utilization, reset times).
 * - Response headers on regular codex/responses calls (passive, cheap).
 *
 * All parsing is defensive: ChatGPT has changed this payload before, and a
 * malformed body must never throw into the request hot path.
 *
 * All timestamps are milliseconds since epoch (Date.now() compatible).
 */

export const OPENAI_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Usage snapshot for one stored ChatGPT account. */
export interface OpenAICodexAccountUsageSnapshot {
	source: "endpoint" | "response_headers";
	fetchedAt: number;
	planType?: string;
	allowed?: boolean;
	limitReached: boolean;
	/** 100 - max(primary, secondary) window utilization, when known. */
	remainingPercent?: number;
	primaryUsedPercent?: number;
	secondaryUsedPercent?: number;
	/** Earliest window reset (ms since epoch) when known. */
	resetAt?: number;
	error?: string;
}

interface UsageWindow {
	used_percent?: unknown;
	reset_at?: unknown;
	reset_after_seconds?: unknown;
	limit_window_seconds?: unknown;
}

interface UsagePayload {
	account_id?: unknown;
	plan_type?: unknown;
	plan?: unknown;
	rate_limit?: {
		allowed?: unknown;
		limit_reached?: unknown;
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	} | null;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function clampPercent(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	return Math.min(100, Math.max(0, value));
}

/** ChatGPT sends reset times as epoch seconds; normalize to milliseconds. */
function normalizeResetAt(value: unknown): number | undefined {
	const num = asFiniteNumber(value);
	if (num === undefined || num <= 0) return undefined;
	return num < 1e12 ? num * 1000 : num;
}

function readWindow(window: UsageWindow | null | undefined): { usedPercent?: number; resetAt?: number } {
	if (!window || typeof window !== "object") return {};
	return {
		usedPercent: clampPercent(asFiniteNumber(window.used_percent)),
		resetAt: normalizeResetAt(window.reset_at),
	};
}

/**
 * Fetch usage for a single account from the wham/usage endpoint.
 * Resolves with an error-carrying snapshot instead of throwing, so callers
 * can probe many accounts and tolerate individual failures.
 */
export async function fetchOpenAICodexUsage(options: {
	accessToken: string;
	accountId: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<OpenAICodexAccountUsageSnapshot> {
	const { accessToken, accountId, signal } = options;
	const fetchImpl = options.fetchImpl ?? fetch;
	const fetchedAt = Date.now();
	try {
		const response = await fetchImpl(OPENAI_CODEX_USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"ChatGPT-Account-Id": accountId,
				Accept: "application/json",
			},
			signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				source: "endpoint",
				fetchedAt,
				limitReached: false,
				error: `Usage check failed (${response.status}): ${text.slice(0, 200) || response.statusText}`,
			};
		}
		const body = (await response.json()) as UsagePayload;
		return summarizeOpenAICodexUsage(body, fetchedAt);
	} catch (error) {
		return {
			source: "endpoint",
			fetchedAt,
			limitReached: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Summarize a wham/usage payload into a snapshot. `fetchedAt` should be the
 * time the fetch started/completed (ms since epoch).
 */
export function summarizeOpenAICodexUsage(payload: unknown, fetchedAt: number): OpenAICodexAccountUsageSnapshot {
	const body = (payload ?? {}) as UsagePayload;
	const rateLimit = body.rate_limit && typeof body.rate_limit === "object" ? body.rate_limit : undefined;

	// account_id, when present, must be a string; anything else means this is
	// not a wham/usage payload at all.
	if (body.account_id !== undefined && typeof body.account_id !== "string") {
		return {
			source: "endpoint",
			fetchedAt,
			limitReached: false,
			error: "Unrecognized usage payload: invalid account_id",
		};
	}

	const planType =
		typeof body.plan_type === "string" && body.plan_type.length > 0
			? body.plan_type
			: typeof body.plan === "string" && body.plan.length > 0
				? body.plan
				: undefined;

	const allowed = typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : undefined;
	const limitReachedFlag = rateLimit?.limit_reached === true;

	const primary = readWindow(rateLimit?.primary_window);
	const secondary = readWindow(rateLimit?.secondary_window);

	// A 2xx body is only trustworthy when it carries a recognized availability
	// signal: an explicit boolean limit_reached, a negative allowed flag, or at
	// least one window with a numeric used_percent. Negative signals are always
	// honored (they can only exclude an account, never prefer one), but a
	// positive all-clear needs concrete evidence: callers prefer accounts by
	// remaining quota, so a malformed payload must surface as an error rather
	// than a fabricated "full quota remaining".
	const recognized =
		typeof rateLimit?.limit_reached === "boolean" ||
		allowed === false ||
		primary.usedPercent !== undefined ||
		secondary.usedPercent !== undefined;
	if (!recognized) {
		return {
			source: "endpoint",
			fetchedAt,
			limitReached: false,
			error: "Unrecognized usage payload: no rate-limit availability signal",
		};
	}

	const windowMax = Math.max(
		primary.usedPercent ?? Number.NEGATIVE_INFINITY,
		secondary.usedPercent ?? Number.NEGATIVE_INFINITY,
	);
	const remainingPercent = windowMax === Number.NEGATIVE_INFINITY ? undefined : 100 - windowMax;
	const windowExhausted = primary.usedPercent === 100 || secondary.usedPercent === 100;

	const resetCandidates = [primary.resetAt, secondary.resetAt].filter((v): v is number => v !== undefined);

	return {
		source: "endpoint",
		fetchedAt,
		planType,
		allowed,
		limitReached: allowed === false || limitReachedFlag || windowExhausted,
		remainingPercent,
		primaryUsedPercent: primary.usedPercent,
		secondaryUsedPercent: secondary.usedPercent,
		resetAt: resetCandidates.length > 0 ? Math.min(...resetCandidates) : undefined,
	};
}

/**
 * Parse the passive usage headers ChatGPT attaches to codex/responses
 * responses. Header names are matched case-insensitively. Returns undefined
 * when no recognizable usage header is present.
 */
export function parseOpenAICodexUsageHeaders(
	headers: Record<string, string>,
): OpenAICodexAccountUsageSnapshot | undefined {
	const lookup = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) {
		lookup.set(key.toLowerCase(), value);
	}

	const primaryUsedPercent = clampPercent(asFiniteNumber(lookup.get("x-codex-primary-used-percent")));
	const secondaryUsedPercent = clampPercent(asFiniteNumber(lookup.get("x-codex-secondary-used-percent")));
	const primaryResetAt = normalizeResetAt(lookup.get("x-codex-primary-reset-at"));
	const secondaryResetAt = normalizeResetAt(lookup.get("x-codex-secondary-reset-at"));

	if (
		primaryUsedPercent === undefined &&
		secondaryUsedPercent === undefined &&
		primaryResetAt === undefined &&
		secondaryResetAt === undefined
	) {
		return undefined;
	}

	const windowMax = Math.max(
		primaryUsedPercent ?? Number.NEGATIVE_INFINITY,
		secondaryUsedPercent ?? Number.NEGATIVE_INFINITY,
	);
	const remainingPercent = windowMax === Number.NEGATIVE_INFINITY ? undefined : 100 - windowMax;
	const resetCandidates = [primaryResetAt, secondaryResetAt].filter((v): v is number => v !== undefined);

	return {
		source: "response_headers",
		fetchedAt: Date.now(),
		limitReached: primaryUsedPercent === 100 || secondaryUsedPercent === 100,
		remainingPercent,
		primaryUsedPercent,
		secondaryUsedPercent,
		resetAt: resetCandidates.length > 0 ? Math.min(...resetCandidates) : undefined,
	};
}

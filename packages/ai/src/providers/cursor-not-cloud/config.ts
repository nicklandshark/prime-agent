// Schema/client generation is atomic with agent.proto and protocol fixtures.
export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.08.11-e8db854";

const CLIENT_VERSION_RE = /^cli-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Resolve a header-safe explicit override before the bundled tested client pin. */
export function resolveCursorClientVersion(explicit?: string): string {
	const candidate = explicit ?? process.env.CURSOR_NOT_CLOUD_CLIENT_VERSION ?? CURSOR_CLIENT_VERSION;
	if (!CLIENT_VERSION_RE.test(candidate)) {
		throw new Error(
			"Cursor client version must be a header-safe cli-... value (set CURSOR_NOT_CLOUD_CLIENT_VERSION)",
		);
	}
	return candidate;
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host === "::1") return true;
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	return !!match && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255);
}

/** Validate and canonicalize the single trusted Cursor RPC origin. */
export function normalizeCursorOrigin(value = CURSOR_API_URL): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Cursor base URL must be an absolute HTTPS origin");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Cursor base URL must not contain credentials, query parameters, or a fragment");
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		throw new Error("Cursor base URL must be an origin without a path");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
		throw new Error("Cursor base URL requires HTTPS (HTTP is allowed only for loopback tests)");
	}
	return url.origin;
}

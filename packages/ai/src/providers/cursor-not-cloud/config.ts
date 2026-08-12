// Schema/client generation is atomic with agent.proto and protocol fixtures.
export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.08.11-e8db854";

const CLIENT_VERSION_RE = /^cli-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Resolve a header-safe explicit override before the bundled schema-matched pin. */
export function resolveCursorClientVersion(explicit?: string): string {
	const candidate = explicit ?? process.env.CURSOR_NOT_CLOUD_CLIENT_VERSION ?? CURSOR_CLIENT_VERSION;
	if (!CLIENT_VERSION_RE.test(candidate)) {
		throw new Error(
			"Cursor client version must be a header-safe cli-... value (set CURSOR_NOT_CLOUD_CLIENT_VERSION)",
		);
	}
	return candidate;
}

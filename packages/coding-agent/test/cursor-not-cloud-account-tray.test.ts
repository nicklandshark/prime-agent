import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCursorNotCloudAccountManager } from "../src/core/cursor-not-cloud-account-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

const dirs: string[] = [];

function jwt(sub: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;
}

function source(valueFingerprint: string) {
	return {
		provider: "cursor-not-cloud",
		source: "stored",
		identityFingerprint: "identity",
		valueFingerprint,
	} as const;
}

function callTray(token: ReturnType<typeof source> | undefined, thinking = "high", fast = true): string {
	const fakeThis = Object.create(InteractiveMode.prototype);
	fakeThis.connectionState = {
		model: { provider: "cursor-not-cloud", name: "Cursor Grok 4.5", reasoning: true },
		thinkingLevel: thinking,
		serviceTier: fast ? "priority" : "default",
	};
	Object.defineProperty(fakeThis, "modelRegistry", {
		value: { getCurrentProviderAuthSourceToken: () => token },
		configurable: true,
	});
	return (InteractiveMode as any).prototype.getModelTrayLabel.call(fakeThis);
}

afterEach(() => {
	getCursorNotCloudAccountManager().clear();
	delete process.env.CURSOR_AGENT_CLI_CONFIG_FILE;
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Cursor subscription account tray", () => {
	it("shows full verified local email with resolved thinking/fast and never crosses credential fingerprints", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-identity-"));
		dirs.push(dir);
		const config = join(dir, "cli-config.json");
		process.env.CURSOR_AGENT_CLI_CONFIG_FILE = config;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const manager = getCursorNotCloudAccountManager();

		writeFileSync(
			config,
			JSON.stringify({ authInfo: { authId: "auth-account-a", email: "account-a@example.test" } }),
		);
		const tokenA = source("fingerprint-a");
		manager.observeCredential(jwt("auth-account-a"), tokenA);
		expect(callTray(tokenA)).toBe("Cursor Grok 4.5 (account-a@example.test) • high • fast");

		writeFileSync(
			config,
			JSON.stringify({ authInfo: { authId: "auth-account-b", email: "account-b@example.test" } }),
		);
		const tokenB = source("fingerprint-b");
		manager.observeCredential(jwt("auth-account-b"), tokenB);
		expect(callTray(tokenB, "medium", false)).toBe("Cursor Grok 4.5 (account-b@example.test) • medium");
		expect(manager.getDisplayLabel(tokenA)).toBeUndefined();

		manager.invalidate(tokenB);
		expect(callTray(undefined)).toBe("Cursor Grok 4.5 • high • fast");
	});

	it("falls back to shortened stable auth id, then Cursor subscription", () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
		const manager = getCursorNotCloudAccountManager();
		const identified = source("identified");
		manager.observeCredential(jwt("abcdefghijklmnop"), identified);
		expect(manager.getDisplayLabel(identified)).toBe("abcdefgh…");
		const opaque = source("opaque");
		manager.observeCredential("opaque-access-token", opaque);
		expect(manager.getDisplayLabel(opaque)).toBe("Cursor subscription");
	});
});

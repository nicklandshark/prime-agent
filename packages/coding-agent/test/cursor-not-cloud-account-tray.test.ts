import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getCursorNotCloudAccountManager } from "../src/core/cursor-not-cloud-account-manager.js";
import { ModelRegistry } from "../src/core/model-registry.js";
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

function callTray(token: { valueFingerprint: string } | undefined, thinking = "high", fast = true): string {
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
		expect(manager.getDisplayLabel(tokenA)).toBe("account-a@example.test");

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

	it("updates a runtime credential label asynchronously from bounded GetMe", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ email: "runtime@example.test", authId: "runtime-auth" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const manager = getCursorNotCloudAccountManager();
		const runtime = { ...source("runtime-fingerprint"), source: "runtime" as const };
		manager.observeCredential("opaque-runtime-token", runtime);
		expect(callTray(runtime)).toBe("Cursor Grok 4.5 (Cursor subscription) • high • fast");
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
		await vi.waitFor(() => expect(callTray(runtime)).toBe("Cursor Grok 4.5 (runtime@example.test) • high • fast"));
	});

	it("removes the runtime account suffix after the active override is removed", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
		const auth = AuthStorage.inMemory();
		auth.setRuntimeApiKey("cursor-not-cloud", jwt("runtime-account-id"));
		const registry = ModelRegistry.inMemory(auth);
		const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high")!;
		const resolved = await registry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.sourceToken) throw new Error("missing runtime source");
		expect(callTray(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud"))).toContain("(");
		auth.removeRuntimeApiKey("cursor-not-cloud");
		expect(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud")).toBeUndefined();
		expect(callTray(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud"))).toBe(
			"Cursor Grok 4.5 • high • fast",
		);
		expect(getCursorNotCloudAccountManager().getDisplayLabel(resolved.sourceToken)).toBe("Cursor subscription");
	});

	it.each(["logout", "remove"] as const)("removes the stored account suffix after %s", async (operation) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
		const auth = AuthStorage.inMemory({
			"cursor-not-cloud": { type: "api_key", key: jwt("stored-account-id") },
		});
		const registry = ModelRegistry.inMemory(auth);
		const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high")!;
		const resolved = await registry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.sourceToken) throw new Error("missing stored source");
		expect(callTray(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud"))).toContain("(");
		auth[operation]("cursor-not-cloud");
		expect(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud")).toBeUndefined();
		expect(callTray(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud"))).toBe(
			"Cursor Grok 4.5 • high • fast",
		);
		expect(getCursorNotCloudAccountManager().getDisplayLabel(resolved.sourceToken)).toBe("Cursor subscription");
	});

	it("does not let an invalidated pending identity repopulate its fingerprint", async () => {
		let resolveIdentity!: (response: Response) => void;
		vi.spyOn(globalThis, "fetch").mockReturnValue(
			new Promise((resolve) => {
				resolveIdentity = resolve;
			}),
		);
		const manager = getCursorNotCloudAccountManager();
		const runtime = source("invalidated-pending");
		manager.observeCredential("opaque-runtime-token", runtime);
		manager.invalidate(runtime);
		resolveIdentity(
			new Response(JSON.stringify({ email: "stale@example.test" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(manager.getDisplayLabel(runtime)).toBe("Cursor subscription");
	});
});

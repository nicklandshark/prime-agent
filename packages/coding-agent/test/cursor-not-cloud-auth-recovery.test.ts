import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { type AuthSourceToken, AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "cursor-auth-recovery-"));
	dirs.push(dir);
	const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high");
	if (!model) throw new Error("missing cursor model");
	const agent = new Agent({
		getApiKey: () => "failed-token",
		initialState: { model, systemPrompt: "test", tools: [] },
	});
	const auth = AuthStorage.inMemory();
	auth.setRuntimeApiKey("cursor-not-cloud", "failed-token");
	const registry = ModelRegistry.inMemory(auth);
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(dir, dir),
		cwd: dir,
		modelRegistry: registry,
		resourceLoader: createTestResourceLoader(),
	});
	const internals = session as unknown as {
		_processAgentEvent(event: AgentEvent): Promise<void>;
		_handleRetryableError(message: AssistantMessage): Promise<boolean>;
	};
	const source: AuthSourceToken = {
		provider: "cursor-not-cloud",
		source: "runtime",
		identityFingerprint: "runtime-source",
		valueFingerprint: "failed-value",
	};
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "cursor-not-cloud",
		provider: "cursor-not-cloud",
		model: model.id,
		timestamp: Date.now(),
		stopReason: "error",
		errorStatus: 401,
		errorMessage: "Provider authentication failed",
		diagnostics: [{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "auth", status: 401 } }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	registry.bindRequestAuthSource({ result: async () => message } as never, source);
	return { session, registry, internals, source, message };
}

async function finishAuthFailure(value: ReturnType<typeof fixture>) {
	await Promise.resolve();
	await value.internals._processAgentEvent({ type: "message_end", message: value.message });
	await value.internals._processAgentEvent({ type: "agent_end", messages: [value.message] });
}

describe("cursor-not-cloud AgentSession auth recovery", () => {
	it("retries exactly once when the official credential fingerprint rotated", async () => {
		const value = fixture();
		const recover = vi.spyOn(value.registry, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(true);
		const retry = vi.spyOn(value.internals, "_handleRetryableError").mockResolvedValueOnce(true);
		await finishAuthFailure(value);
		expect(recover).toHaveBeenCalledOnce();
		expect(recover).toHaveBeenCalledWith(value.source);
		expect(retry).toHaveBeenCalledOnce();
		value.session.dispose();
	});

	it("attributes a late Run failure to its bound old source after a concurrent credential change", async () => {
		const value = fixture();
		const newer: AuthSourceToken = { ...value.source, valueFingerprint: "new-value" };
		vi.spyOn(value.registry, "getCurrentProviderAuthSourceToken").mockReturnValue(newer);
		const recover = vi.spyOn(value.registry, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(true);
		const stale = vi.spyOn(value.registry, "markProviderAuthSourceStale");
		vi.spyOn(value.internals, "_handleRetryableError").mockResolvedValueOnce(true);
		await finishAuthFailure(value);
		expect(recover).toHaveBeenCalledWith(value.source);
		expect(stale).not.toHaveBeenCalled();
		value.session.dispose();
	});

	it("does not generic-retry an unchanged credential; marks the exact source stale and guides login", async () => {
		const value = fixture();
		const recover = vi.spyOn(value.registry, "recoverCursorNotCloudOfficialCredential").mockResolvedValueOnce(false);
		const stale = vi.spyOn(value.registry, "markProviderAuthSourceStale").mockReturnValueOnce(true);
		const retry = vi.spyOn(value.internals, "_handleRetryableError").mockResolvedValue(false);
		await finishAuthFailure(value);
		expect(recover).toHaveBeenCalledOnce();
		expect(stale).toHaveBeenCalledWith(value.source);
		expect(retry).not.toHaveBeenCalled();
		expect(value.message.errorMessage).toMatch(/\/login.*Cursor subscription credential/i);
		value.session.dispose();
	});

	it("coalesces concurrent old-fingerprint recovery and lets both requests observe rotation", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
		const auth = AuthStorage.inMemory({
			"cursor-not-cloud": {
				type: "oauth",
				access: "old-access",
				refresh: "",
				expires: Date.now() + 60_000,
				credentialSource: "cursor-cli",
			},
		});
		const registry = ModelRegistry.inMemory(auth);
		const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high")!;
		const oldAuth = await registry.getApiKeyAndHeaders(model);
		if (!oldAuth.ok || !oldAuth.sourceToken) throw new Error("missing old request source");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const refresh = vi.spyOn(auth, "forceRefreshOAuthToken").mockImplementation(async () => {
			await gate;
			auth.set("cursor-not-cloud", {
				type: "oauth",
				access: "new-access",
				refresh: "",
				expires: Date.now() + 60_000,
				credentialSource: "cursor-cli",
			});
			return "new-access";
		});

		const first = registry.recoverCursorNotCloudOfficialCredential(oldAuth.sourceToken);
		const second = registry.recoverCursorNotCloudOfficialCredential(oldAuth.sourceToken);
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		release();
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		const next = await registry.getApiKeyAndHeaders(model);
		expect(next).toMatchObject({ ok: true, apiKey: "new-access" });
		if (!next.ok) throw new Error("missing rotated auth");
		expect(next.sourceToken?.valueFingerprint).not.toBe(oldAuth.sourceToken.valueFingerprint);
	});

	it("coalesces concurrent unchanged recovery and stales only the old bound source", async () => {
		const auth = AuthStorage.inMemory({
			"cursor-not-cloud": {
				type: "oauth",
				access: "unchanged-access",
				refresh: "",
				expires: Date.now() + 60_000,
				credentialSource: "cursor-cli",
			},
		});
		const registry = ModelRegistry.inMemory(auth);
		const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high")!;
		const requestAuth = await registry.getApiKeyAndHeaders(model);
		if (!requestAuth.ok || !requestAuth.sourceToken) throw new Error("missing request source");
		const refresh = vi.spyOn(auth, "forceRefreshOAuthToken").mockResolvedValue("unchanged-access");
		await expect(
			Promise.all([
				registry.recoverCursorNotCloudOfficialCredential(requestAuth.sourceToken),
				registry.recoverCursorNotCloudOfficialCredential(requestAuth.sourceToken),
			]),
		).resolves.toEqual([false, false]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(registry.markProviderAuthSourceStale(requestAuth.sourceToken)).toBe(true);
		expect(registry.getCurrentProviderAuthSourceToken("cursor-not-cloud")).toBeUndefined();
	});
});

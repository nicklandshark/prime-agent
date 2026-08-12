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
	vi.spyOn(registry, "getCurrentProviderAuthSourceToken").mockReturnValue(source);
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
	return { session, registry, internals, source, message };
}

async function finishAuthFailure(value: ReturnType<typeof fixture>) {
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
});

import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

interface FakeAccount {
	accountId: string;
	email?: string;
	label: string;
	active: boolean;
}

function createManager(accounts: FakeAccount[]) {
	return {
		getCachedAccounts: vi.fn(() => accounts),
		listAccounts: vi.fn(async () => accounts),
		selectAccount: vi.fn((accountId: string) => accounts.find((account) => account.accountId === accountId)),
		onAccountChanged: vi.fn(() => () => {}),
	};
}

function createTrayThis(options: {
	model?: { provider: string; name: string; reasoning?: boolean };
	thinkingLevel?: string;
	serviceTier?: string;
	manager?: unknown;
}) {
	// Inherit from the prototype so private helpers (getCurrentModel, ...) resolve.
	const fakeThis = Object.create(InteractiveMode.prototype);
	fakeThis.connectionState = options.model
		? {
				model: options.model,
				thinkingLevel: options.thinkingLevel ?? "off",
				serviceTier: options.serviceTier,
			}
		: undefined;
	// modelRegistry is a getter-only accessor on the prototype; shadow it.
	Object.defineProperty(fakeThis, "modelRegistry", {
		value: options.manager === undefined ? {} : { openAICodexAccounts: options.manager },
		configurable: true,
	});
	return fakeThis;
}

function callTrayLabel(fakeThis: unknown): string {
	return (InteractiveMode as any).prototype.getModelTrayLabel.call(fakeThis);
}

const codexModel = { provider: "openai-codex", name: "gpt-5.5-codex", reasoning: false };
const activeAccount: FakeAccount = {
	accountId: "acc-1234567890",
	email: "user@example.com",
	label: "user@example.com",
	active: true,
};

describe("InteractiveMode.getModelTrayLabel openai-codex account", () => {
	test("appends the active account email for openai-codex models", () => {
		const fakeThis = createTrayThis({ model: codexModel, manager: createManager([activeAccount]) });

		expect(callTrayLabel(fakeThis)).toBe("gpt-5.5-codex (user@example.com)");
	});

	test("falls back to the account label, then a shortened accountId", () => {
		const labelOnly = createTrayThis({
			model: codexModel,
			manager: createManager([{ accountId: "acc-1", label: "Work", active: true }]),
		});
		expect(callTrayLabel(labelOnly)).toBe("gpt-5.5-codex (Work)");

		const idOnly = createTrayThis({
			model: codexModel,
			manager: createManager([{ accountId: "abcdefghijklmnop", label: "abcdefghijklmnop", active: true }]),
		});
		expect(callTrayLabel(idOnly)).toBe("gpt-5.5-codex (abcdefgh…)");
	});

	test("keeps thinking level and service tier parts after the account suffix", () => {
		const fakeThis = createTrayThis({
			model: { ...codexModel, reasoning: true },
			thinkingLevel: "high",
			serviceTier: "priority",
			manager: createManager([activeAccount]),
		});

		expect(callTrayLabel(fakeThis)).toBe("gpt-5.5-codex (user@example.com) • high • fast");
	});

	test("leaves other providers untouched", () => {
		const fakeThis = createTrayThis({
			model: { provider: "anthropic", name: "claude-opus-4.1", reasoning: false },
			manager: createManager([activeAccount]),
		});

		expect(callTrayLabel(fakeThis)).toBe("claude-opus-4.1");
	});

	test("omits the suffix without a manager or an active account", () => {
		expect(callTrayLabel(createTrayThis({ model: codexModel }))).toBe("gpt-5.5-codex");

		const noActive = createTrayThis({
			model: codexModel,
			manager: createManager([{ ...activeAccount, active: false }]),
		});
		expect(callTrayLabel(noActive)).toBe("gpt-5.5-codex");
	});

	test("survives a throwing manager cache read", () => {
		const fakeThis = createTrayThis({
			model: codexModel,
			manager: {
				getCachedAccounts: () => {
					throw new Error("boom");
				},
			},
		});

		expect(callTrayLabel(fakeThis)).toBe("gpt-5.5-codex");
	});
});

describe("InteractiveMode.handleOAuthAccountChanged", () => {
	test("reloads auth storage and invalidates footer and model UI", () => {
		const fakeThis = {
			modelRegistry: { authStorage: { reload: vi.fn() } },
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			refreshConnectionModelsAfterAuthChange: vi.fn().mockResolvedValue(undefined),
		};

		(InteractiveMode as any).prototype.handleOAuthAccountChanged.call(fakeThis);

		expect(fakeThis.modelRegistry.authStorage.reload).toHaveBeenCalledTimes(1);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledTimes(1);
		expect(fakeThis.updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(fakeThis.refreshConnectionModelsAfterAuthChange).toHaveBeenCalledTimes(1);
	});
});

import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	getOpenAICodexAccountDisplayLabel,
	getOpenAICodexAccountManager,
	type OpenAICodexAccountSelectorCallbacks,
	OpenAICodexAccountSelectorComponent,
	type OpenAICodexAccountView,
} from "../src/modes/interactive/components/openai-codex-account-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type InputListener = (data: string) => { consume?: boolean } | undefined;

const BOUNDS = { x: 10, y: 5, width: 60 };

function makeAccount(overrides: Partial<OpenAICodexAccountView> = {}): OpenAICodexAccountView {
	return {
		accountId: "acc-1",
		email: "first@example.com",
		label: "first@example.com",
		active: false,
		...overrides,
	};
}

function makeUsage(overrides: Partial<OpenAICodexAccountView["usage"]> = {}): OpenAICodexAccountView["usage"] {
	return {
		source: "endpoint",
		fetchedAt: 1_000,
		limitReached: false,
		...overrides,
	};
}

function createCallbacks(): {
	onSelect: ReturnType<typeof vi.fn<(account: OpenAICodexAccountView) => void>>;
	onAddAccount: ReturnType<typeof vi.fn<() => void>>;
	onCancel: ReturnType<typeof vi.fn<() => void>>;
} {
	return {
		onSelect: vi.fn<(account: OpenAICodexAccountView) => void>(),
		onAddAccount: vi.fn<() => void>(),
		onCancel: vi.fn<() => void>(),
	};
}

function createSelector(
	accounts: OpenAICodexAccountView[],
	callbacks: OpenAICodexAccountSelectorCallbacks,
	probing = false,
): {
	selector: OpenAICodexAccountSelectorComponent;
	listeners: Set<InputListener>;
	tui: TUI;
	lines: string[];
} {
	const listeners = new Set<InputListener>();
	const tui = {
		terminal: { columns: 100, rows: 24 },
		requestRender: vi.fn(),
		addInputListener: vi.fn((listener: InputListener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}),
	} as unknown as TUI;
	const selector = new OpenAICodexAccountSelectorComponent(tui, accounts, callbacks, { getRows: () => 24 }, probing);
	// Establish list hit regions and content geometry, then place the content on
	// screen the way CenteredOverlayComponent would.
	const lines = selector.render(BOUNDS.width);
	selector.setScreenBounds({ ...BOUNDS, height: lines.length });
	return { selector, listeners, tui, lines };
}

function leftPress(x: number, y: number): string {
	return `\x1b[<0;${x};${y}M`;
}

/** 1-based mouse row for the rendered content line containing `text`. */
function mouseRowFor(lines: string[], text: string): number {
	const index = lines.findIndex((line) => stripAnsi(line).includes(text));
	expect(index, `rendered line containing "${text}"`).toBeGreaterThanOrEqual(0);
	return BOUNDS.y + index + 1;
}

function renderText(selector: OpenAICodexAccountSelectorComponent, width = BOUNDS.width): string {
	return stripAnsi(selector.render(width).join("\n"));
}

describe("OpenAICodexAccountSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders accounts with usage meta, an active marker, and an add-account row", () => {
		const accounts = [
			makeAccount({ active: true, usage: makeUsage({ remainingPercent: 42, planType: "plus" }) }),
			makeAccount({
				accountId: "acc-2",
				email: "second@example.com",
				label: "second@example.com",
				usage: makeUsage({ limitReached: true }),
			}),
		];
		const { selector } = createSelector(accounts, createCallbacks());

		const output = renderText(selector);

		expect(output).toContain("first@example.com");
		expect(output).toContain("●");
		expect(output).toContain("42% left");
		expect(output).toContain("Plus");
		expect(output).toContain("second@example.com");
		expect(output).toContain("exhausted");
		expect(output).toContain("Add new account");
		expect(output).toContain("OAuth");
		// Only the active account gets the marker.
		expect(output.indexOf("●")).toBe(output.lastIndexOf("●"));
	});

	it("shows probing and unavailable usage states", () => {
		const { selector } = createSelector([makeAccount({ usage: undefined })], createCallbacks(), true);
		expect(renderText(selector)).toContain("checking…");

		selector.updateAccounts([makeAccount({ usage: undefined })], false);
		expect(renderText(selector)).toContain("usage unavailable");
	});

	it("moves selection with arrows and activates accounts with Enter", () => {
		const callbacks = createCallbacks();
		const { selector } = createSelector(
			[makeAccount(), makeAccount({ accountId: "acc-2", email: "second@example.com", label: "second@example.com" })],
			callbacks,
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
		expect(callbacks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-2" }));
	});

	it("activates the add-account row at the end of the list", () => {
		const callbacks = createCallbacks();
		const { selector } = createSelector([makeAccount()], callbacks);

		selector.handleInput("\x1b[B");
		selector.handleInput("\r");

		expect(callbacks.onAddAccount).toHaveBeenCalledTimes(1);
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it("cancels with Escape", () => {
		const callbacks = createCallbacks();
		const { selector } = createSelector([makeAccount()], callbacks);

		selector.handleInput("\x1b");

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
	});

	it("activates rows on left mouse press and consumes the event", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createSelector(
			[makeAccount(), makeAccount({ accountId: "acc-2", email: "second@example.com", label: "second@example.com" })],
			callbacks,
		);
		const listener = [...listeners][0];
		expect(listener).toBeDefined();

		const result = listener?.(leftPress(21, mouseRowFor(lines, "second@example.com")));

		expect(result).toEqual({ consume: true });
		expect(callbacks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-2" }));
	});

	it("activates the add-account row via mouse", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createSelector([makeAccount()], callbacks);
		const listener = [...listeners][0];

		const result = listener?.(leftPress(21, mouseRowFor(lines, "Add new account")));

		expect(result).toEqual({ consume: true });
		expect(callbacks.onAddAccount).toHaveBeenCalledTimes(1);
	});

	it("ignores mouse events outside rows and non-press events", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createSelector([makeAccount()], callbacks);
		const listener = [...listeners][0];
		const rowY = mouseRowFor(lines, "first@example.com");

		// Panel header line (above the list), outside the content width, a release,
		// and a wheel event are all left for the TUI's own mouse handling.
		expect(listener?.(leftPress(21, mouseRowFor(lines, "OpenAI Codex accounts")))).toBeUndefined();
		expect(listener?.(leftPress(5, rowY))).toBeUndefined();
		expect(listener?.(`\x1b[<0;21;${rowY}m`)).toBeUndefined();
		expect(listener?.(`\x1b[<64;21;${rowY}M`)).toBeUndefined();
		expect(callbacks.onSelect).not.toHaveBeenCalled();
		expect(callbacks.onAddAccount).not.toHaveBeenCalled();
	});

	it("updateAccounts refreshes rows and clamps the selection", () => {
		const callbacks = createCallbacks();
		const { selector, tui } = createSelector(
			[
				makeAccount(),
				makeAccount({ accountId: "acc-2", email: "second@example.com", label: "second@example.com" }),
				makeAccount({ accountId: "acc-3", email: "third@example.com", label: "third@example.com" }),
			],
			callbacks,
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B"); // add-account row
		selector.updateAccounts([makeAccount()]);

		expect(renderText(selector)).not.toContain("third@example.com");
		expect(tui.requestRender).toHaveBeenCalled();
		// The selection was clamped back onto the remaining add-account row.
		selector.handleInput("\r");
		expect(callbacks.onAddAccount).toHaveBeenCalledTimes(1);
	});

	it("dispose removes the mouse listener", () => {
		const { selector, listeners } = createSelector([makeAccount()], createCallbacks());
		expect(listeners.size).toBe(1);

		selector.dispose();

		expect(listeners.size).toBe(0);
	});
});

describe("getOpenAICodexAccountManager", () => {
	it("returns undefined when the registry has no manager", () => {
		expect(getOpenAICodexAccountManager({})).toBeUndefined();
		expect(getOpenAICodexAccountManager(undefined)).toBeUndefined();
		expect(getOpenAICodexAccountManager({ openAICodexAccounts: {} })).toBeUndefined();
	});

	it("returns a structurally valid manager", () => {
		const manager = {
			getCachedAccounts: () => [],
			listAccounts: async () => [],
			selectAccount: (accountId: string) => makeAccount({ accountId }),
			onAccountChanged: () => () => {},
		};
		expect(getOpenAICodexAccountManager({ openAICodexAccounts: manager })).toBe(manager);
	});
});

describe("getOpenAICodexAccountDisplayLabel", () => {
	it("prefers email, then label, then a shortened accountId", () => {
		expect(getOpenAICodexAccountDisplayLabel(makeAccount())).toBe("first@example.com");
		expect(getOpenAICodexAccountDisplayLabel(makeAccount({ email: undefined, label: "Work account" }))).toBe(
			"Work account",
		);
		expect(
			getOpenAICodexAccountDisplayLabel(
				makeAccount({ accountId: "abcdefghijklmnop", email: undefined, label: "abcdefghijklmnop" }),
			),
		).toBe("abcdefgh…");
		expect(getOpenAICodexAccountDisplayLabel(makeAccount({ accountId: "short", email: undefined, label: "" }))).toBe(
			"short",
		);
	});
});

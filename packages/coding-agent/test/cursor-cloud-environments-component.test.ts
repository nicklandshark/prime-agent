import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CursorCloudEnvironmentView } from "../src/core/cursor-cloud-environments.js";
import {
	type CursorCloudEnvironmentsCallbacks,
	CursorCloudEnvironmentsComponent,
	getCursorCloudRepoShortName,
} from "../src/modes/interactive/components/cursor-cloud-environments.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type InputListener = (data: string) => { consume?: boolean } | undefined;

const BOUNDS = { x: 10, y: 5, width: 60 };

function makeEnv(overrides: Partial<CursorCloudEnvironmentView> = {}): CursorCloudEnvironmentView {
	return {
		name: "ea-tycoon",
		agentId: "bc-aaa",
		repo: "https://github.com/acme/ea-tycoon",
		via: "bore.pub",
		sshTarget: "1.2.3.4.bore.pub:2200@ubuntu",
		serverStatus: "unknown",
		...overrides,
	};
}

function createCallbacks(): {
	onSelect: ReturnType<typeof vi.fn<(env: CursorCloudEnvironmentView) => void>>;
	onCancel: ReturnType<typeof vi.fn<() => void>>;
} {
	return {
		onSelect: vi.fn<(env: CursorCloudEnvironmentView) => void>(),
		onCancel: vi.fn<() => void>(),
	};
}

function createComponent(
	environments: CursorCloudEnvironmentView[],
	callbacks: CursorCloudEnvironmentsCallbacks,
	probing = false,
): {
	component: CursorCloudEnvironmentsComponent;
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
	const component = new CursorCloudEnvironmentsComponent(tui, environments, callbacks, { getRows: () => 24 }, probing);
	// Establish list hit regions and content geometry, then place the content on
	// screen the way CenteredOverlayComponent would.
	const lines = component.render(BOUNDS.width);
	component.setScreenBounds({ ...BOUNDS, height: lines.length });
	return { component, listeners, tui, lines };
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

function renderText(component: CursorCloudEnvironmentsComponent, width = BOUNDS.width): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("CursorCloudEnvironmentsComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the panel title, subtitle, and environment rows", () => {
		const { component } = createComponent(
			[
				makeEnv({ serverStatus: "ACTIVE" }),
				makeEnv({
					name: "side-quest",
					agentId: "bc-bbb",
					repo: "https://github.com/acme/side-quest.git",
					via: "tailscale",
				}),
			],
			createCallbacks(),
		);

		const output = renderText(component);

		expect(output).toContain("Cursor Cloud");
		expect(output).toContain("Your cloud environments");
		expect(output).toContain("ea-tycoon");
		expect(output).toContain("ea-tycoon · bore.pub");
		expect(output).toContain("side-quest · tailscale");
		// Only the ACTIVE environment gets the marker.
		expect(output).toContain("●");
		expect(output.indexOf("●")).toBe(output.lastIndexOf("●"));
	});

	it("shows meta states for each server status", () => {
		const { component } = createComponent(
			[
				makeEnv({ name: "active-env", serverStatus: "ACTIVE" }),
				makeEnv({ name: "archived-env", agentId: "bc-b", serverStatus: "ARCHIVED" }),
				makeEnv({ name: "gone-env", agentId: "bc-c", serverStatus: "missing" }),
				makeEnv({ name: "foreign-env", agentId: "bc-d", serverStatus: "unregistered" }),
			],
			createCallbacks(),
		);

		const output = renderText(component);

		expect(output).toContain("active");
		expect(output).toContain("archived");
		expect(output).toContain("gone");
		expect(output).toContain("unregistered");
	});

	it("shows checking… while probing, then verification states for registry-only rows", () => {
		const { component } = createComponent([makeEnv()], createCallbacks(), true);
		expect(renderText(component)).toContain("checking…");

		component.updateEnvironments([makeEnv({ lastVerifiedAt: undefined })], false);
		expect(renderText(component)).toContain("never verified");

		component.updateEnvironments(
			[makeEnv({ lastVerifiedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() })],
			false,
		);
		expect(renderText(component)).toContain("stale");

		component.updateEnvironments([makeEnv({ lastVerifiedAt: new Date().toISOString() })], false);
		expect(renderText(component)).toContain("verified");
	});

	it("renders a server-error note when provided", () => {
		const { component } = createComponent([makeEnv()], createCallbacks(), true);
		component.updateEnvironments([makeEnv()], false, "server unreachable (HTTP 401)");
		expect(renderText(component)).toContain("server unreachable (HTTP 401)");
	});

	it("renders an empty state when there are no environments", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent([], callbacks);
		expect(renderText(component)).toContain("No Cursor cloud environments");

		// The empty-state row is not activatable.
		component.handleInput("\r");
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it("moves selection with arrows and activates environments with Enter", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent([makeEnv(), makeEnv({ name: "side-quest", agentId: "bc-bbb" })], callbacks);

		component.handleInput("\x1b[B");
		component.handleInput("\r");

		expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
		expect(callbacks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ agentId: "bc-bbb" }));
	});

	it("cancels with Escape", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent([makeEnv()], callbacks);

		component.handleInput("\x1b");

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
	});

	it("activates rows on left mouse press and consumes the event", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createComponent(
			[makeEnv(), makeEnv({ name: "side-quest", agentId: "bc-bbb" })],
			callbacks,
		);
		const listener = [...listeners][0];
		expect(listener).toBeDefined();

		const result = listener?.(leftPress(21, mouseRowFor(lines, "side-quest")));

		expect(result).toEqual({ consume: true });
		expect(callbacks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ agentId: "bc-bbb" }));
	});

	it("ignores mouse events outside rows", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createComponent([makeEnv()], callbacks);
		const listener = [...listeners][0];

		// Panel header line (above the list) and outside the content width.
		expect(listener?.(leftPress(21, mouseRowFor(lines, "Cursor Cloud")))).toBeUndefined();
		expect(listener?.(leftPress(5, mouseRowFor(lines, "ea-tycoon · bore.pub")))).toBeUndefined();
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it("updateEnvironments swaps rows and keeps the selection in range", () => {
		const callbacks = createCallbacks();
		const { component, tui } = createComponent(
			[makeEnv(), makeEnv({ name: "side-quest", agentId: "bc-bbb" })],
			callbacks,
		);

		component.handleInput("\x1b[B");
		component.updateEnvironments([makeEnv({ name: "fresh", agentId: "bc-ccc", serverStatus: "ACTIVE" })]);

		const output = renderText(component);
		expect(output).toContain("fresh");
		expect(output).not.toContain("side-quest");
		expect(tui.requestRender).toHaveBeenCalled();

		component.handleInput("\r");
		expect(callbacks.onSelect).toHaveBeenCalledWith(expect.objectContaining({ agentId: "bc-ccc" }));
	});

	it("dispose removes the mouse listener", () => {
		const { component, listeners } = createComponent([makeEnv()], createCallbacks());
		expect(listeners.size).toBe(1);
		component.dispose();
		expect(listeners.size).toBe(0);
	});
});

describe("getCursorCloudRepoShortName", () => {
	it("strips the .git suffix and trailing slashes", () => {
		expect(getCursorCloudRepoShortName("https://github.com/acme/ea-tycoon.git")).toBe("ea-tycoon");
		expect(getCursorCloudRepoShortName("https://github.com/acme/ea-tycoon/")).toBe("ea-tycoon");
		expect(getCursorCloudRepoShortName("git@github.com:acme/ea-tycoon")).toBe("ea-tycoon");
	});
});

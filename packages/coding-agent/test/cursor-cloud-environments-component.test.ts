import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	CursorCloudEnvironmentsView,
	CursorCloudEnvironmentView,
	CursorCloudNamedEnvironmentView,
} from "../src/core/cursor-cloud-environments.js";
import {
	type CursorCloudEnvironmentsCallbacks,
	CursorCloudEnvironmentsComponent,
	type CursorCloudViewerSelection,
	formatCursorCloudRelativeTime,
	formatCursorCloudSelectionStatus,
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

function makeNamedEnv(overrides: Partial<CursorCloudNamedEnvironmentView> = {}): CursorCloudNamedEnvironmentView {
	return {
		name: "sedona-agent",
		agentCount: 2,
		lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
		...overrides,
	};
}

function makeView(overrides: Partial<CursorCloudEnvironmentsView> = {}): CursorCloudEnvironmentsView {
	return { namedEnvironments: [], builderEnvironments: [], ...overrides };
}

function createCallbacks(): {
	onSelect: ReturnType<typeof vi.fn<(selection: CursorCloudViewerSelection) => void>>;
	onCancel: ReturnType<typeof vi.fn<() => void>>;
} {
	return {
		onSelect: vi.fn<(selection: CursorCloudViewerSelection) => void>(),
		onCancel: vi.fn<() => void>(),
	};
}

function createComponent(
	view: CursorCloudEnvironmentsView,
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
	const component = new CursorCloudEnvironmentsComponent(tui, view, callbacks, { getRows: () => 24 }, probing);
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

	it("renders the panel title, subtitle, and both section headers with their rows", () => {
		const { component } = createComponent(
			makeView({
				namedEnvironments: [makeNamedEnv()],
				builderEnvironments: [
					makeEnv({ serverStatus: "ACTIVE" }),
					makeEnv({
						name: "side-quest",
						agentId: "bc-bbb",
						repo: "https://github.com/acme/side-quest.git",
						via: "tailscale",
					}),
				],
			}),
			createCallbacks(),
		);

		const output = renderText(component);

		expect(output).toContain("Cursor Cloud");
		expect(output).toContain("Your cloud environments");
		expect(output).toContain("Cloud environments");
		expect(output).toContain("Builder environments (SSH)");
		// Named environment row: name, fixed secondary, agent count + activity meta.
		expect(output).toContain("sedona-agent");
		expect(output).toContain("cloud environment");
		expect(output).toContain("2 agents · 2h ago");
		// Builder environment rows keep the existing rendering.
		expect(output).toContain("ea-tycoon · bore.pub");
		expect(output).toContain("side-quest · tailscale");
		// Only the ACTIVE builder environment gets the marker.
		expect(output).toContain("●");
		expect(output.indexOf("●")).toBe(output.lastIndexOf("●"));
		// The named section renders above the builder section.
		expect(output.indexOf("Cloud environments")).toBeLessThan(output.indexOf("Builder environments (SSH)"));
	});

	it("renders placeholders under each section when the view is empty", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent(makeView(), callbacks);

		const output = renderText(component);

		expect(output).toContain("Cloud environments");
		expect(output).toContain("no cloud environments found");
		expect(output).toContain("Builder environments (SSH)");
		expect(output).toContain("no builder environments registered");

		// Placeholder rows are not activatable.
		component.handleInput("\r");
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it("shows checking… placeholders and builder metas while probing", () => {
		const { component } = createComponent(makeView({ builderEnvironments: [makeEnv()] }), createCallbacks(), true);
		const output = renderText(component);
		expect(output).toContain("checking…");
	});

	it("marks the named section unavailable when the server failed", () => {
		const { component } = createComponent(makeView({ builderEnvironments: [makeEnv()] }), createCallbacks(), true);
		component.updateEnvironments(
			makeView({ builderEnvironments: [makeEnv()] }),
			false,
			"server unreachable (HTTP 401)",
		);

		const output = renderText(component);
		expect(output).toContain("server unavailable");
		expect(output).toContain("server unreachable (HTTP 401)");
	});

	it("shows meta states for each builder server status", () => {
		const { component } = createComponent(
			makeView({
				builderEnvironments: [
					makeEnv({ name: "active-env", serverStatus: "ACTIVE" }),
					makeEnv({ name: "archived-env", agentId: "bc-b", serverStatus: "ARCHIVED" }),
					makeEnv({ name: "gone-env", agentId: "bc-c", serverStatus: "missing" }),
					makeEnv({ name: "foreign-env", agentId: "bc-d", serverStatus: "unregistered" }),
				],
			}),
			createCallbacks(),
		);

		const output = renderText(component);

		expect(output).toContain("active");
		expect(output).toContain("archived");
		expect(output).toContain("gone");
		expect(output).toContain("unregistered");
	});

	it("shows verification states for registry-only builder rows", () => {
		const { component } = createComponent(makeView({ builderEnvironments: [makeEnv()] }), createCallbacks());

		component.updateEnvironments(makeView({ builderEnvironments: [makeEnv({ lastVerifiedAt: undefined })] }), false);
		expect(renderText(component)).toContain("never verified");

		component.updateEnvironments(
			makeView({
				builderEnvironments: [
					makeEnv({ lastVerifiedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }),
				],
			}),
			false,
		);
		expect(renderText(component)).toContain("stale");

		component.updateEnvironments(
			makeView({ builderEnvironments: [makeEnv({ lastVerifiedAt: new Date().toISOString() })] }),
			false,
		);
		expect(renderText(component)).toContain("verified");
	});

	it("renders an active-runs footer when the server reports in-flight runs", () => {
		const { component } = createComponent(
			makeView({
				builderEnvironments: [makeEnv()],
				activeRuns: [
					{
						agentId: "bc-aaa",
						agentName: "ea-tycoon",
						environmentName: "sedona-agent",
						latestRunId: "run-1",
						updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
					},
				],
			}),
			createCallbacks(),
		);

		const output = renderText(component);
		expect(output).toContain("Active runs");
		expect(output).toContain("ea-tycoon in sedona-agent");
		expect(output).toContain("5m ago");
	});

	it("caps the active-runs footer with a more line", () => {
		const runs = [0, 1, 2, 3, 4].map((i) => ({
			agentId: `bc-${i}`,
			agentName: `agent-${i}`,
			latestRunId: `run-${i}`,
		}));
		const { component } = createComponent(
			makeView({ builderEnvironments: [makeEnv()], activeRuns: runs }),
			createCallbacks(),
		);

		const output = renderText(component);
		expect(output).toContain("agent-0");
		expect(output).toContain("agent-2");
		expect(output).not.toContain("agent-4");
		expect(output).toContain("…and 2 more");
	});

	it("moves selection across sections with arrows and activates with Enter", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent(
			makeView({
				namedEnvironments: [makeNamedEnv()],
				builderEnvironments: [makeEnv()],
			}),
			callbacks,
		);

		// First row is the named environment.
		component.handleInput("\r");
		expect(callbacks.onSelect).toHaveBeenCalledWith({
			kind: "named",
			environment: expect.objectContaining({ name: "sedona-agent" }),
		});

		// Arrow down crosses into the builder section.
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(callbacks.onSelect).toHaveBeenCalledWith({
			kind: "builder",
			environment: expect.objectContaining({ agentId: "bc-aaa" }),
		});
		expect(callbacks.onSelect).toHaveBeenCalledTimes(2);
	});

	it("never lands on placeholder rows", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent(makeView({ namedEnvironments: [makeNamedEnv()] }), callbacks);

		// Down from the only named env would hit the builder placeholder; it stays put.
		component.handleInput("\x1b[B");
		component.handleInput("\r");
		expect(callbacks.onSelect).toHaveBeenCalledTimes(1);
		expect(callbacks.onSelect).toHaveBeenCalledWith({
			kind: "named",
			environment: expect.objectContaining({ name: "sedona-agent" }),
		});
	});

	it("cancels with Escape", () => {
		const callbacks = createCallbacks();
		const { component } = createComponent(makeView({ builderEnvironments: [makeEnv()] }), callbacks);

		component.handleInput("\x1b");

		expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
	});

	it("activates rows on left mouse press and consumes the event", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createComponent(
			makeView({
				namedEnvironments: [makeNamedEnv()],
				builderEnvironments: [makeEnv(), makeEnv({ name: "side-quest", agentId: "bc-bbb" })],
			}),
			callbacks,
		);
		const listener = [...listeners][0];
		expect(listener).toBeDefined();

		const result = listener?.(leftPress(21, mouseRowFor(lines, "side-quest")));

		expect(result).toEqual({ consume: true });
		expect(callbacks.onSelect).toHaveBeenCalledWith({
			kind: "builder",
			environment: expect.objectContaining({ agentId: "bc-bbb" }),
		});
	});

	it("ignores mouse presses on section headers and outside rows", () => {
		const callbacks = createCallbacks();
		const { listeners, lines } = createComponent(
			makeView({ namedEnvironments: [makeNamedEnv()], builderEnvironments: [makeEnv()] }),
			callbacks,
		);
		const listener = [...listeners][0];

		// Section headers, the panel title (above the list), and outside the content width.
		expect(listener?.(leftPress(21, mouseRowFor(lines, "Cloud environments")))).toBeUndefined();
		expect(listener?.(leftPress(21, mouseRowFor(lines, "Builder environments (SSH)")))).toBeUndefined();
		expect(listener?.(leftPress(21, mouseRowFor(lines, "Cursor Cloud")))).toBeUndefined();
		expect(listener?.(leftPress(5, mouseRowFor(lines, "ea-tycoon · bore.pub")))).toBeUndefined();
		expect(callbacks.onSelect).not.toHaveBeenCalled();
	});

	it("updateEnvironments swaps sections and keeps the selection in range", () => {
		const callbacks = createCallbacks();
		const { component, tui } = createComponent(
			makeView({
				namedEnvironments: [makeNamedEnv()],
				builderEnvironments: [makeEnv(), makeEnv({ name: "side-quest", agentId: "bc-bbb" })],
			}),
			callbacks,
		);

		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.updateEnvironments(
			makeView({ namedEnvironments: [makeNamedEnv({ name: "fresh-env", agentCount: 1 })] }),
		);

		const output = renderText(component);
		expect(output).toContain("fresh-env");
		expect(output).not.toContain("side-quest");
		expect(tui.requestRender).toHaveBeenCalled();

		component.handleInput("\r");
		expect(callbacks.onSelect).toHaveBeenCalledWith({
			kind: "named",
			environment: expect.objectContaining({ name: "fresh-env" }),
		});
	});

	it("dispose removes the mouse listener", () => {
		const { component, listeners } = createComponent(
			makeView({ builderEnvironments: [makeEnv()] }),
			createCallbacks(),
		);
		expect(listeners.size).toBe(1);
		component.dispose();
		expect(listeners.size).toBe(0);
	});
});

describe("formatCursorCloudSelectionStatus", () => {
	it("explains how to call a cloud agent into a named environment", () => {
		expect(
			formatCursorCloudSelectionStatus({ kind: "named", environment: makeNamedEnv({ name: "sedona-agent" }) }),
		).toBe('sedona-agent — call a cloud agent into it with rlm(model=..., environment="sedona-agent")');
	});

	it("shows the SSH target for a builder environment", () => {
		expect(formatCursorCloudSelectionStatus({ kind: "builder", environment: makeEnv() })).toBe(
			"ea-tycoon — SSH target: 1.2.3.4.bore.pub:2200@ubuntu",
		);
	});

	it("notes when a builder environment has no SSH target", () => {
		expect(
			formatCursorCloudSelectionStatus({ kind: "builder", environment: makeEnv({ sshTarget: undefined }) }),
		).toBe("ea-tycoon — no SSH target recorded");
	});
});

describe("formatCursorCloudRelativeTime", () => {
	it("formats recent timestamps compactly", () => {
		expect(formatCursorCloudRelativeTime(new Date(Date.now() - 30 * 1000).toISOString())).toBe("just now");
		expect(formatCursorCloudRelativeTime(new Date(Date.now() - 5 * 60 * 1000).toISOString())).toBe("5m ago");
		expect(formatCursorCloudRelativeTime(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString())).toBe("3h ago");
		expect(formatCursorCloudRelativeTime(new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString())).toBe(
			"4d ago",
		);
	});

	it("returns unknown for unparseable timestamps", () => {
		expect(formatCursorCloudRelativeTime("not a date")).toBe("unknown");
	});
});

describe("getCursorCloudRepoShortName", () => {
	it("strips the .git suffix and trailing slashes", () => {
		expect(getCursorCloudRepoShortName("https://github.com/acme/ea-tycoon.git")).toBe("ea-tycoon");
		expect(getCursorCloudRepoShortName("https://github.com/acme/ea-tycoon/")).toBe("ea-tycoon");
		expect(getCursorCloudRepoShortName("git@github.com:acme/ea-tycoon")).toBe("ea-tycoon");
	});
});

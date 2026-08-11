import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CursorCloudEnvironmentsResult,
	CursorCloudEnvironmentsView,
} from "../src/core/cursor-cloud-environments.js";
import type { CursorCloudViewerSelection } from "../src/modes/interactive/components/cursor-cloud-environments.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * Wiring tests for the /cursor-cloud viewer: selecting a row shows a status
 * line and never prefills the editor, and the background server refresh swaps
 * the combined view into the component until the overlay is closed.
 */

const cachedView: CursorCloudEnvironmentsView = { namedEnvironments: [], builderEnvironments: [] };

let componentCallbacks: {
	onSelect(selection: CursorCloudViewerSelection): void;
	onCancel(): void;
};
let componentDispose: ReturnType<typeof vi.fn>;
let componentUpdate: ReturnType<typeof vi.fn>;
let resolveList: ((result: CursorCloudEnvironmentsResult) => void) | undefined;

vi.mock("../src/core/cursor-cloud-environments.js", () => ({
	getCachedCursorCloudEnvironments: vi.fn(() => cachedView),
	listCursorCloudEnvironments: vi.fn(
		() =>
			new Promise<CursorCloudEnvironmentsResult>((resolve) => {
				resolveList = resolve;
			}),
	),
}));

vi.mock("../src/modes/interactive/components/cursor-cloud-environments.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/modes/interactive/components/cursor-cloud-environments.js")>();
	return {
		...actual,
		CursorCloudEnvironmentsComponent: vi.fn(function (
			this: Record<string, unknown>,
			_tui: unknown,
			_view: CursorCloudEnvironmentsView,
			callbacks: typeof componentCallbacks,
		) {
			componentCallbacks = callbacks;
			this.dispose = componentDispose;
			this.updateEnvironments = componentUpdate;
		}),
	};
});

interface ModeHarness {
	ui: { terminal: { rows: number }; requestRender: ReturnType<typeof vi.fn> };
	editor: { setText: ReturnType<typeof vi.fn> };
	showStatus: ReturnType<typeof vi.fn>;
	showFullPaneOverlay: ReturnType<typeof vi.fn>;
	overlayHandle: { hide: ReturnType<typeof vi.fn> };
}

function createMode(): ModeHarness {
	const overlayHandle = { hide: vi.fn() };
	const harness: ModeHarness = {
		ui: { terminal: { rows: 24 }, requestRender: vi.fn() },
		editor: { setText: vi.fn() },
		showStatus: vi.fn(),
		showFullPaneOverlay: vi.fn(() => overlayHandle),
		overlayHandle,
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

function showViewer(mode: ModeHarness): Promise<void> {
	return (
		InteractiveMode.prototype as unknown as { showCursorCloudEnvironments(): Promise<void> }
	).showCursorCloudEnvironments.call(mode);
}

describe("InteractiveMode /cursor-cloud viewer", () => {
	beforeEach(() => {
		componentDispose = vi.fn();
		componentUpdate = vi.fn();
		resolveList = undefined;
	});

	it("shows a status line for a named environment without prefilling the editor", async () => {
		const mode = createMode();
		const done = showViewer(mode);

		componentCallbacks.onSelect({
			kind: "named",
			environment: { name: "sedona-agent", agentCount: 3, lastActivityAt: "2026-08-10T00:00:00.000Z" },
		});
		await done;

		expect(mode.showStatus).toHaveBeenCalledWith(
			'sedona-agent — call a cloud agent into it with rlm(model=..., environment="sedona-agent")',
		);
		expect(mode.editor.setText).not.toHaveBeenCalled();
		expect(mode.overlayHandle.hide).toHaveBeenCalled();
		expect(componentDispose).toHaveBeenCalled();
	});

	it("shows the SSH target for a builder environment without prefilling the editor", async () => {
		const mode = createMode();
		const done = showViewer(mode);

		componentCallbacks.onSelect({
			kind: "builder",
			environment: {
				name: "ea-tycoon",
				agentId: "bc-aaa",
				sshTarget: "1.2.3.4.bore.pub:2200@ubuntu",
				serverStatus: "ACTIVE",
			},
		});
		await done;

		expect(mode.showStatus).toHaveBeenCalledWith("ea-tycoon — SSH target: 1.2.3.4.bore.pub:2200@ubuntu");
		expect(mode.editor.setText).not.toHaveBeenCalled();
	});

	it("closes without a status line when cancelled", async () => {
		const mode = createMode();
		const done = showViewer(mode);

		componentCallbacks.onCancel();
		await done;

		expect(mode.showStatus).not.toHaveBeenCalled();
		expect(mode.editor.setText).not.toHaveBeenCalled();
		expect(mode.overlayHandle.hide).toHaveBeenCalled();
	});

	it("swaps the server-refreshed view into the component while open", async () => {
		const mode = createMode();
		const done = showViewer(mode);

		const refreshed: CursorCloudEnvironmentsResult = {
			namedEnvironments: [{ name: "sedona-agent", agentCount: 2, lastActivityAt: "2026-08-10T00:00:00.000Z" }],
			builderEnvironments: [],
			activeRuns: [],
			serverError: undefined,
		};
		resolveList?.(refreshed);
		await vi.waitFor(() => {
			expect(componentUpdate).toHaveBeenCalledWith(refreshed, false, undefined);
		});

		componentCallbacks.onCancel();
		await done;
	});

	it("ignores the server response after the viewer is closed", async () => {
		const mode = createMode();
		const done = showViewer(mode);

		componentCallbacks.onCancel();
		await done;

		resolveList?.({ namedEnvironments: [], builderEnvironments: [] });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(componentUpdate).not.toHaveBeenCalled();
	});
});

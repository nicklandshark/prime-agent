import {
	type Component,
	type Focusable,
	isFocusable,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

interface CenteredOverlayOptions {
	getRows: () => number;
	maxContentWidth?: number;
	verticalOffset?: number;
}

interface InputHandler {
	handleInput(data: string): void;
}

/** Zero-based screen rectangle occupied by centered overlay content. */
export interface ScreenBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Components that want their centered content bounds (e.g. for mouse hit-testing). */
export interface ScreenBoundsAware {
	setScreenBounds(bounds: ScreenBounds): void;
}

function isScreenBoundsAware(component: Component): component is Component & ScreenBoundsAware {
	return typeof (component as { setScreenBounds?: unknown }).setScreenBounds === "function";
}

export interface FullPaneOverlayOptions {
	maxContentWidth?: number;
	fullWidth?: boolean;
	suspendFullscreenMouse?: boolean;
}

function hasInputHandler(component: Component): component is Component & InputHandler {
	return typeof (component as { handleInput?: unknown }).handleInput === "function";
}

/** Shows a component as a full-pane centered overlay on the given TUI. */
export function showFullPaneOverlay(
	ui: TUI,
	component: Component,
	options: number | FullPaneOverlayOptions = 80,
): OverlayHandle {
	const { maxContentWidth, suspendFullscreenMouse } =
		typeof options === "number"
			? { maxContentWidth: options, suspendFullscreenMouse: undefined }
			: {
					maxContentWidth: options.fullWidth ? undefined : (options.maxContentWidth ?? 80),
					suspendFullscreenMouse: options.suspendFullscreenMouse,
				};
	const overlayOptions: OverlayOptions = {
		width: "100%",
		maxHeight: "100%",
		row: 0,
		col: 0,
	};
	if (suspendFullscreenMouse) {
		overlayOptions.suspendFullscreenMouse = true;
	}

	return ui.showOverlay(
		new CenteredOverlayComponent(component, {
			getRows: () => ui.terminal.rows,
			maxContentWidth,
		}),
		overlayOptions,
	);
}

export class CenteredOverlayComponent implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly component: Component,
		private readonly options: CenteredOverlayOptions,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (isFocusable(this.component)) {
			this.component.focused = value;
		}
	}

	invalidate(): void {
		this.component.invalidate?.();
	}

	handleInput(data: string): void {
		if (hasInputHandler(this.component)) {
			this.component.handleInput(data);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const contentWidth = Math.min(safeWidth, this.options.maxContentWidth ?? safeWidth);
		const left = Math.max(0, Math.floor((safeWidth - contentWidth) / 2));
		const contentLines = this.component.render(contentWidth).map((line) => this.place(line, safeWidth, left));
		const requestedRows = this.options.getRows();
		const targetRows =
			Number.isFinite(requestedRows) && requestedRows > 0
				? Math.max(contentLines.length, Math.floor(requestedRows))
				: contentLines.length;
		const centeredTop = Math.floor((targetRows - contentLines.length) / 2) + (this.options.verticalOffset ?? 0);
		const topPadding = Math.max(0, Math.min(centeredTop, targetRows - contentLines.length));
		const bottomPadding = Math.max(0, targetRows - contentLines.length - topPadding);

		// The overlay is pinned at row 0 / col 0, so zero-based offsets within the
		// rendered frame are already zero-based screen coordinates.
		if (isScreenBoundsAware(this.component)) {
			this.component.setScreenBounds({ x: left, y: topPadding, width: contentWidth, height: contentLines.length });
		}

		return [
			...Array.from({ length: topPadding }, () => this.blank(safeWidth)),
			...contentLines,
			...Array.from({ length: bottomPadding }, () => this.blank(safeWidth)),
		];
	}

	private place(text: string, width: number, left: number): string {
		const safeLeft = Math.max(0, Math.min(left, width));
		const contentWidth = Math.max(0, width - safeLeft);
		const content = truncateToWidth(text, contentWidth, "");
		const right = Math.max(0, width - safeLeft - visibleWidth(content));
		return " ".repeat(safeLeft) + content + " ".repeat(right);
	}

	private blank(width: number): string {
		return " ".repeat(width);
	}
}

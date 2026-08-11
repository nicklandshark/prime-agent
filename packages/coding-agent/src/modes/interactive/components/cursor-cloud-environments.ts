/**
 * /cursor-cloud environments viewer.
 *
 * Lists the user's Cursor cloud environments (local tunnel registry joined
 * with live Cursor Cloud Agents API state) in the same MenuPanel/MenuList
 * style as the provider/account selector screen. Rows render immediately from
 * the registry; updateEnvironments() swaps in the server-joined view once the
 * fetch resolves.
 */

import {
	Container,
	type Focusable,
	getKeybindings,
	isMouseSequence,
	parseSgrMouseEvent,
	TruncatedText,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { CursorCloudEnvironmentView } from "../../../core/cursor-cloud-environments.js";
import { theme } from "../theme/theme.js";
import type { ScreenBounds, ScreenBoundsAware } from "./centered-overlay.js";
import {
	getMenuListLayout,
	getMenuPanelInnerWidth,
	MENU_PANEL_PADDING_Y,
	MenuList,
	type MenuListLayout,
	MenuPanel,
	MenuRow,
	type MenuViewportProvider,
} from "./menu-panel.js";

// MOUSE_BUTTON_LEFT is not re-exported from the pi-tui index; keep the SGR base
// button code local (packages/tui/src/mouse.ts).
const MOUSE_BUTTON_LEFT = 0;

/** A tunnel verification older than this renders as "stale". */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const PREFERRED_VISIBLE_ENVIRONMENTS = 8;
/** Panel padding (2) + title (1) + subtitle (1) + header separator (1). */
const ENV_LIST_RESERVED_ROWS = 5;
const ENV_SCROLL_INDICATOR_ROWS = 1;
const DEFAULT_TITLE = "Cursor Cloud";
const DEFAULT_SUBTITLE = "Your cloud environments";

export interface CursorCloudEnvironmentsCallbacks {
	onSelect(environment: CursorCloudEnvironmentView): void;
	onCancel(): void;
}

export interface CursorCloudEnvironmentsOptions extends MenuViewportProvider {
	title?: string;
	subtitle?: string;
}

/** Short display name for a repo URL: last path segment without `.git`. */
export function getCursorCloudRepoShortName(repo: string): string {
	const trimmed = repo.replace(/\/+$/, "");
	const last = trimmed.split("/").pop() ?? trimmed;
	return last.endsWith(".git") ? last.slice(0, -".git".length) : last;
}

export class CursorCloudEnvironmentsComponent extends Container implements Focusable, ScreenBoundsAware {
	private environments: CursorCloudEnvironmentView[];
	private probing: boolean;
	private note: string | undefined;
	private selectedIndex = 0;
	private visibleStartIndex = 0;
	private readonly listContainer: MenuList;
	private listLayout: MenuListLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_ENVIRONMENTS,
		reservedRows: ENV_LIST_RESERVED_ROWS,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});
	private readonly subtitle: string;
	private screenBounds: ScreenBounds | undefined;
	private listContentTop: number | undefined;
	private readonly removeInputListener: (() => void) | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		private readonly tui: TUI | undefined,
		environments: CursorCloudEnvironmentView[],
		private readonly callbacks: CursorCloudEnvironmentsCallbacks,
		private readonly options: CursorCloudEnvironmentsOptions = {},
		probing = false,
	) {
		super();
		this.environments = [...environments];
		this.probing = probing;
		this.subtitle = options.subtitle ?? DEFAULT_SUBTITLE;

		const panel = new MenuPanel({
			title: options.title ?? DEFAULT_TITLE,
			subtitle: this.subtitle,
		});
		this.addChild(panel);

		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
		panel.addChild(this.listContainer);

		this.updateList();

		// Mouse input is never dispatched to components (fullscreen input consumes
		// it), so hit-testing hooks into the pre-fullscreen input listener chain.
		if (tui) {
			this.removeInputListener = tui.addInputListener((data) => this.handleMouseInput(data));
		}
	}

	/** Zero-based screen bounds of the centered content, set by the overlay. */
	setScreenBounds(bounds: ScreenBounds): void {
		this.screenBounds = bounds;
	}

	/** Swap in freshly fetched environments (e.g. after the server responds). */
	updateEnvironments(environments: CursorCloudEnvironmentView[], probing = false, note?: string): void {
		this.environments = [...environments];
		this.probing = probing;
		this.note = note;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.environments.length - 1));
		this.updateList();
		this.tui?.requestRender();
	}

	/** Remove the global mouse listener; the overlay handle hides the view. */
	dispose(): void {
		this.removeInputListener?.();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.environments.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.environments.length === 0) return;
			this.selectedIndex = Math.min(this.environments.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.activateRow(this.selectedIndex);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.callbacks.onCancel();
		}
	}

	override render(width: number): string[] {
		const previousLayout = this.listLayout;
		this.updateLayout();
		if (
			this.listLayout.compact !== previousLayout.compact ||
			this.listLayout.visibleItems !== previousLayout.visibleItems
		) {
			this.updateList();
		}
		const lines = super.render(width);
		this.listContentTop = this.computeListContentTop(width);
		return lines;
	}

	private activateRow(index: number): void {
		const environment = this.environments[index];
		if (!environment) return;
		this.callbacks.onSelect(environment);
	}

	private handleMouseInput(data: string): { consume: true } | undefined {
		if (!isMouseSequence(data)) {
			return undefined;
		}
		const event = parseSgrMouseEvent(data);
		if (!event || event.button !== MOUSE_BUTTON_LEFT || !event.press || event.motion) {
			return undefined;
		}
		const bounds = this.screenBounds;
		const listTop = this.listContentTop;
		if (!bounds || listTop === undefined) {
			return undefined;
		}
		const x = event.x - 1;
		if (x < bounds.x || x >= bounds.x + bounds.width) {
			return undefined;
		}
		const renderRow = event.y - 1 - bounds.y - listTop;
		const childIndex = this.listContainer.getRowIndexAt(renderRow);
		if (childIndex === undefined) {
			return undefined;
		}
		const target = this.visibleTargets[childIndex];
		if (target === undefined) {
			return undefined;
		}
		this.selectedIndex = this.visibleStartIndex + childIndex;
		this.updateList();
		this.tui?.requestRender();
		this.activateRow(this.selectedIndex);
		return { consume: true };
	}

	/** Row targets for the currently visible window; empty-state rows are undefined. */
	private get visibleTargets(): (CursorCloudEnvironmentView | undefined)[] {
		if (this.environments.length === 0) {
			return [undefined];
		}
		return this.environments.slice(this.visibleStartIndex, this.visibleStartIndex + this.listLayout.visibleItems);
	}

	private buildRow(environment: CursorCloudEnvironmentView, selected: boolean): MenuRow {
		const activeMarker = environment.serverStatus === "ACTIVE" ? `${theme.fg("success", "●")} ` : "";
		return new MenuRow({
			primary: `${activeMarker}${environment.name}`,
			secondary: formatEnvironmentSecondary(environment),
			meta: this.formatMeta(environment),
			selected,
		});
	}

	private formatMeta(environment: CursorCloudEnvironmentView): string {
		if (this.probing) {
			return theme.fg("muted", "checking…");
		}
		switch (environment.serverStatus) {
			case "ACTIVE":
				return theme.fg("success", "active");
			case "ARCHIVED":
				return theme.fg("muted", "archived");
			case "missing":
				return theme.fg("warning", "gone");
			case "unregistered":
				return theme.fg("muted", "unregistered");
			default:
				return formatVerifiedMeta(environment);
		}
	}

	private updateList(): void {
		this.updateLayout();
		this.listContainer.clear();

		if (this.environments.length === 0) {
			this.visibleStartIndex = 0;
			this.listContainer.addChild(
				new MenuRow({
					primary: "No Cursor cloud environments",
					secondary: this.probing ? "Checking the registry and server…" : "Agents with SSH tunnels appear here",
					selected: false,
				}),
			);
		} else {
			const maxVisible = this.listLayout.visibleItems;
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.environments.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, this.environments.length);
			this.visibleStartIndex = startIndex;

			for (let i = startIndex; i < endIndex; i++) {
				this.listContainer.addChild(this.buildRow(this.environments[i], i === this.selectedIndex));
			}

			if (startIndex > 0 || endIndex < this.environments.length) {
				const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.environments.length})`);
				this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
			}
		}

		if (this.note) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${this.note}`), 1, 0));
		}
	}

	/**
	 * Row offset of the MenuList within this component's rendered output. The
	 * list is the MenuPanel's only child, so it starts right after the panel's
	 * fixed header: top padding + title + wrapped subtitle + separator row.
	 */
	private computeListContentTop(width: number): number {
		const innerWidth = getMenuPanelInnerWidth(width);
		const subtitleRows = wrapTextWithAnsi(theme.fg("muted", this.subtitle), innerWidth).length;
		return MENU_PANEL_PADDING_Y + 1 + subtitleRows + 1;
	}

	private updateLayout(): void {
		this.listLayout = getMenuListLayout({
			getRows: this.options.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_ENVIRONMENTS,
			totalItems: Math.max(1, this.environments.length),
			reservedRows: ENV_LIST_RESERVED_ROWS,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: ENV_SCROLL_INDICATOR_ROWS,
		});
	}
}

function formatEnvironmentSecondary(environment: CursorCloudEnvironmentView): string | undefined {
	const parts: string[] = [];
	if (environment.repo) {
		parts.push(getCursorCloudRepoShortName(environment.repo));
	}
	if (environment.via) {
		parts.push(environment.via);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatVerifiedMeta(environment: CursorCloudEnvironmentView): string {
	if (!environment.lastVerifiedAt) {
		return theme.fg("muted", "never verified");
	}
	const verifiedAt = Date.parse(environment.lastVerifiedAt);
	if (!Number.isFinite(verifiedAt)) {
		return theme.fg("muted", "never verified");
	}
	if (Date.now() - verifiedAt > STALE_AFTER_MS) {
		return theme.fg("warning", "stale");
	}
	return theme.fg("success", "verified");
}

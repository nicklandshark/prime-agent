/**
 * /cursor-cloud environments viewer (a pure viewer, not a spawn launcher).
 *
 * Renders two labeled sections in the same MenuPanel/MenuList style as the
 * provider/account selector screen:
 *
 * - "Cloud environments": named cloud environments where task cloud agents
 *   run (derived from GET /v1/agents; see core/cursor-cloud-environments.ts).
 * - "Builder environments (SSH)": the local SSH-tunnel VMs that local
 *   subagents tunnel into (local registry joined with live server state).
 *
 * plus a small "Active runs" footer while the server reports in-flight runs.
 * Rows render immediately from the cached registry view; updateEnvironments()
 * swaps in the server-joined view once the fetch resolves. Arrow keys and the
 * mouse share a single selection model across both sections.
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
import type {
	CursorCloudActiveRunView,
	CursorCloudEnvironmentsView,
	CursorCloudEnvironmentView,
	CursorCloudNamedEnvironmentView,
} from "../../../core/cursor-cloud-environments.js";
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
/** Rows reserved for the "Cloud environments" / "Builder environments (SSH)" headers inside the list. */
const SECTION_HEADER_ROWS = 2;
const ENV_SCROLL_INDICATOR_ROWS = 1;
/** At most this many active runs are listed before a "…and N more" line. */
const MAX_VISIBLE_ACTIVE_RUNS = 3;
const DEFAULT_TITLE = "Cursor Cloud";
const DEFAULT_SUBTITLE = "Your cloud environments";
const NAMED_SECTION_LABEL = "Cloud environments";
const BUILDER_SECTION_LABEL = "Builder environments (SSH)";
const ACTIVE_RUNS_SECTION_LABEL = "Active runs";

/** The row the user activated: a named cloud environment or a builder environment. */
export type CursorCloudViewerSelection =
	| { kind: "named"; environment: CursorCloudNamedEnvironmentView }
	| { kind: "builder"; environment: CursorCloudEnvironmentView };

export interface CursorCloudEnvironmentsCallbacks {
	onSelect(selection: CursorCloudViewerSelection): void;
	onCancel(): void;
}

export interface CursorCloudEnvironmentsOptions extends MenuViewportProvider {
	title?: string;
	subtitle?: string;
}

/**
 * Status line shown when a row is activated. The viewer never prefills the
 * editor; it tells the user how to reach the selected environment instead.
 */
export function formatCursorCloudSelectionStatus(selection: CursorCloudViewerSelection): string {
	if (selection.kind === "named") {
		return `${selection.environment.name} — call a cloud agent into it with rlm(model=..., environment="${selection.environment.name}")`;
	}
	const sshTarget = selection.environment.sshTarget;
	return sshTarget
		? `${selection.environment.name} — SSH target: ${sshTarget}`
		: `${selection.environment.name} — no SSH target recorded`;
}

/** Short display name for a repo URL: last path segment without `.git`. */
export function getCursorCloudRepoShortName(repo: string): string {
	const trimmed = repo.replace(/\/+$/, "");
	const last = trimmed.split("/").pop() ?? trimmed;
	return last.endsWith(".git") ? last.slice(0, -".git".length) : last;
}

/** Compact relative time for activity columns: "just now", "5m ago", "3d ago", … */
export function formatCursorCloudRelativeTime(timestamp: string): string {
	const at = Date.parse(timestamp);
	if (!Number.isFinite(at)) {
		return "unknown";
	}
	const diffMs = Date.now() - at;
	if (diffMs < 60_000) {
		return "just now";
	}
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.floor(hours / 24);
	if (days < 30) {
		return `${days}d ago`;
	}
	const months = Math.floor(days / 30);
	if (months < 12) {
		return `${months}mo ago`;
	}
	return `${Math.floor(months / 12)}y ago`;
}

/**
 * One selectable (or placeholder) row in the flat list. Selection and the
 * scroll window run over this array; placeholders occupy a row so empty
 * sections still show under their header but can never be activated.
 */
type ViewerEntry =
	| { kind: "named"; environment: CursorCloudNamedEnvironmentView }
	| { kind: "builder"; environment: CursorCloudEnvironmentView }
	| { kind: "placeholder"; section: "named" | "builder"; text: string };

export class CursorCloudEnvironmentsComponent extends Container implements Focusable, ScreenBoundsAware {
	private namedEnvironments: CursorCloudNamedEnvironmentView[];
	private builderEnvironments: CursorCloudEnvironmentView[];
	private activeRuns: CursorCloudActiveRunView[] | undefined;
	private probing: boolean;
	private note: string | undefined;
	private entries: ViewerEntry[] = [];
	private selectedIndex = 0;
	/** Maps each MenuList child to its entry index; undefined for headers, footers, and placeholders. */
	private visibleRowTargets: ({ index: number } | undefined)[] = [];
	private readonly listContainer: MenuList;
	private listLayout: MenuListLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_ENVIRONMENTS,
		reservedRows: ENV_LIST_RESERVED_ROWS + SECTION_HEADER_ROWS,
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
		view: CursorCloudEnvironmentsView,
		private readonly callbacks: CursorCloudEnvironmentsCallbacks,
		private readonly options: CursorCloudEnvironmentsOptions = {},
		probing = false,
	) {
		super();
		this.namedEnvironments = [...view.namedEnvironments];
		this.builderEnvironments = [...view.builderEnvironments];
		this.activeRuns = view.activeRuns;
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

	/** Swap in a freshly fetched view (e.g. after the server responds). */
	updateEnvironments(view: CursorCloudEnvironmentsView, probing = false, note?: string): void {
		this.namedEnvironments = [...view.namedEnvironments];
		this.builderEnvironments = [...view.builderEnvironments];
		this.activeRuns = view.activeRuns;
		this.probing = probing;
		this.note = note;
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
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.moveSelection(1);
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
		const entry = this.entries[index];
		if (!entry || entry.kind === "placeholder") return;
		this.callbacks.onSelect(
			entry.kind === "named"
				? { kind: "named", environment: entry.environment }
				: { kind: "builder", environment: entry.environment },
		);
	}

	/** Move the selection by delta rows, skipping placeholders and clamping at the edges. */
	private moveSelection(delta: number): void {
		const entries = this.entries;
		let next = this.selectedIndex;
		for (;;) {
			next += delta;
			if (next < 0 || next >= entries.length) {
				return;
			}
			if (entries[next].kind !== "placeholder") {
				break;
			}
		}
		if (next === this.selectedIndex) {
			return;
		}
		this.selectedIndex = next;
		this.updateList();
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
		const target = this.visibleRowTargets[childIndex];
		if (target === undefined) {
			return undefined;
		}
		this.selectedIndex = target.index;
		this.updateList();
		this.tui?.requestRender();
		this.activateRow(target.index);
		return { consume: true };
	}

	/** Flat selectable rows: named environments, then builder environments, with placeholders for empty sections. */
	private buildEntries(): ViewerEntry[] {
		const entries: ViewerEntry[] = [];
		if (this.namedEnvironments.length === 0) {
			entries.push({ kind: "placeholder", section: "named", text: this.namedPlaceholderText() });
		} else {
			for (const environment of this.namedEnvironments) {
				entries.push({ kind: "named", environment });
			}
		}
		if (this.builderEnvironments.length === 0) {
			entries.push({ kind: "placeholder", section: "builder", text: "no builder environments registered" });
		} else {
			for (const environment of this.builderEnvironments) {
				entries.push({ kind: "builder", environment });
			}
		}
		return entries;
	}

	private namedPlaceholderText(): string {
		if (this.probing) {
			return "checking…";
		}
		return this.note ? "server unavailable" : "no cloud environments found";
	}

	/** Keep the selection on a selectable entry after the entries change. */
	private snapSelection(): void {
		const entries = this.entries;
		if (entries.length === 0) {
			this.selectedIndex = 0;
			return;
		}
		const clamped = Math.max(0, Math.min(this.selectedIndex, entries.length - 1));
		if (entries[clamped].kind !== "placeholder") {
			this.selectedIndex = clamped;
			return;
		}
		for (let i = clamped + 1; i < entries.length; i++) {
			if (entries[i].kind !== "placeholder") {
				this.selectedIndex = i;
				return;
			}
		}
		for (let i = clamped - 1; i >= 0; i--) {
			if (entries[i].kind !== "placeholder") {
				this.selectedIndex = i;
				return;
			}
		}
		this.selectedIndex = clamped;
	}

	private buildRow(entry: ViewerEntry, selected: boolean): MenuRow {
		if (entry.kind === "named") {
			return new MenuRow({
				primary: entry.environment.name,
				secondary: "cloud environment",
				meta: formatNamedEnvironmentMeta(entry.environment),
				selected,
			});
		}
		if (entry.kind === "builder") {
			return this.buildBuilderRow(entry.environment, selected);
		}
		return new MenuRow({ primary: theme.fg("muted", entry.text), selected: false });
	}

	private buildBuilderRow(environment: CursorCloudEnvironmentView, selected: boolean): MenuRow {
		const activeMarker = environment.serverStatus === "ACTIVE" ? `${theme.fg("success", "●")} ` : "";
		return new MenuRow({
			primary: `${activeMarker}${environment.name}`,
			secondary: formatEnvironmentSecondary(environment),
			meta: this.formatBuilderMeta(environment),
			selected,
		});
	}

	private formatBuilderMeta(environment: CursorCloudEnvironmentView): string {
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

	/** Append a non-selectable line (section header, footer text) to the list. */
	private addPlainLine(text: string): void {
		this.listContainer.addChild(new TruncatedText(text, 0, 0));
		this.visibleRowTargets.push(undefined);
	}

	private updateList(): void {
		this.entries = this.buildEntries();
		this.snapSelection();
		this.updateLayout();
		this.listContainer.clear();
		this.visibleRowTargets = [];

		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.entries.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.entries.length);

		let lastSection: "named" | "builder" | undefined;
		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.entries[i];
			const section = entry.kind === "placeholder" ? entry.section : entry.kind;
			if (section !== lastSection) {
				this.addPlainLine(
					theme.bold(theme.fg("muted", section === "named" ? NAMED_SECTION_LABEL : BUILDER_SECTION_LABEL)),
				);
				lastSection = section;
			}
			this.listContainer.addChild(this.buildRow(entry, i === this.selectedIndex));
			this.visibleRowTargets.push(entry.kind === "placeholder" ? undefined : { index: i });
		}

		if (startIndex > 0 || endIndex < this.entries.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.entries.length})`);
			this.addPlainLine(scrollInfo);
		}

		if (this.activeRuns !== undefined && this.activeRuns.length > 0) {
			this.addPlainLine(theme.bold(theme.fg("muted", ACTIVE_RUNS_SECTION_LABEL)));
			for (const run of this.activeRuns.slice(0, MAX_VISIBLE_ACTIVE_RUNS)) {
				this.addPlainLine(theme.fg("muted", `  ${formatActiveRunLine(run)}`));
			}
			if (this.activeRuns.length > MAX_VISIBLE_ACTIVE_RUNS) {
				this.addPlainLine(theme.fg("muted", `  …and ${this.activeRuns.length - MAX_VISIBLE_ACTIVE_RUNS} more`));
			}
		}

		if (this.note) {
			this.addPlainLine(theme.fg("muted", `  ${this.note}`));
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
		const activeRunRows =
			this.activeRuns === undefined || this.activeRuns.length === 0
				? 0
				: 1 +
					Math.min(this.activeRuns.length, MAX_VISIBLE_ACTIVE_RUNS) +
					(this.activeRuns.length > MAX_VISIBLE_ACTIVE_RUNS ? 1 : 0);
		this.listLayout = getMenuListLayout({
			getRows: this.options.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_ENVIRONMENTS,
			totalItems: Math.max(1, this.entries.length),
			reservedRows: ENV_LIST_RESERVED_ROWS + SECTION_HEADER_ROWS + activeRunRows,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: ENV_SCROLL_INDICATOR_ROWS,
		});
	}
}

function formatNamedEnvironmentMeta(environment: CursorCloudNamedEnvironmentView): string {
	const count = `${environment.agentCount} agent${environment.agentCount === 1 ? "" : "s"}`;
	return environment.lastActivityAt
		? `${count} · ${formatCursorCloudRelativeTime(environment.lastActivityAt)}`
		: count;
}

function formatActiveRunLine(run: CursorCloudActiveRunView): string {
	const label = run.agentName ?? run.agentId;
	const where = run.environmentName ? ` in ${run.environmentName}` : "";
	const when = run.updatedAt ? ` — ${formatCursorCloudRelativeTime(run.updatedAt)}` : "";
	return `● ${label}${where}${when}`;
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

/**
 * Account selector for the OpenAI Codex multi-subscription login flow.
 *
 * Lists the ChatGPT accounts already known to the core account manager (with
 * live usage in the right-aligned meta column) plus an "Add new account" row
 * that falls back into the classic OAuth dialog.
 *
 * The manager lives in core (core/openai-codex-account-manager.ts) and is
 * exposed on ModelRegistry as `openAICodexAccounts`; the contract types below
 * are the canonical core/pi-ai definitions, re-exported for UI consumers.
 */

import type { OpenAICodexAccountUsageSnapshot } from "@earendil-works/pi-ai";
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
	OpenAICodexAccountManager as CoreOpenAICodexAccountManager,
	OpenAICodexAccountChangedEvent,
	OpenAICodexAccountView,
} from "../../../core/openai-codex-account-manager.js";
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

// ── Canonical core contract types (re-exported for UI consumers) ────────────

export type { OpenAICodexAccountChangedEvent, OpenAICodexAccountUsageSnapshot, OpenAICodexAccountView };

/** The core account manager consumed by the UI. */
export type OpenAICodexAccountManager = CoreOpenAICodexAccountManager;

/**
 * Resolve the account manager exposed on ModelRegistry as `openAICodexAccounts`.
 * Returns undefined when the registry does not carry one (e.g. partially
 * constructed test doubles) so callers can fall back to the classic
 * single-account flow.
 */
export function getOpenAICodexAccountManager(registry: unknown): OpenAICodexAccountManager | undefined {
	const candidate = (registry as { openAICodexAccounts?: unknown } | null | undefined)?.openAICodexAccounts;
	if (!candidate || typeof candidate !== "object") {
		return undefined;
	}
	const manager = candidate as Partial<OpenAICodexAccountManager>;
	if (
		typeof manager.getCachedAccounts !== "function" ||
		typeof manager.listAccounts !== "function" ||
		typeof manager.selectAccount !== "function"
	) {
		return undefined;
	}
	return manager as OpenAICodexAccountManager;
}

/** Display label for an account: email → label → shortened accountId. */
export function getOpenAICodexAccountDisplayLabel(account: OpenAICodexAccountView): string {
	if (account.email) {
		return account.email;
	}
	if (account.label && account.label !== account.accountId) {
		return account.label;
	}
	return shortenAccountId(account.accountId);
}

function shortenAccountId(accountId: string): string {
	return accountId.length > 10 ? `${accountId.slice(0, 8)}…` : accountId;
}

const PREFERRED_VISIBLE_ACCOUNTS = 8;
/** Panel padding (2) + title (1) + subtitle (1) + header separator (1). */
const ACCOUNT_LIST_RESERVED_ROWS = 5;
const ACCOUNT_SCROLL_INDICATOR_ROWS = 1;
const DEFAULT_TITLE = "OpenAI Codex accounts";
const DEFAULT_SUBTITLE = "Choose an account to use, or add a new one.";

type RowTarget = { type: "account"; account: OpenAICodexAccountView } | { type: "add-account" };

export interface OpenAICodexAccountSelectorCallbacks {
	onSelect(account: OpenAICodexAccountView): void;
	onAddAccount(): void;
	onCancel(): void;
}

export interface OpenAICodexAccountSelectorOptions extends MenuViewportProvider {
	title?: string;
	subtitle?: string;
}

export class OpenAICodexAccountSelectorComponent extends Container implements Focusable, ScreenBoundsAware {
	private accounts: OpenAICodexAccountView[];
	private probing: boolean;
	private selectedIndex = 0;
	private rows: RowTarget[] = [];
	private visibleTargets: RowTarget[] = [];
	private visibleStartIndex = 0;
	private readonly listContainer: MenuList;
	private listLayout: MenuListLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_ACCOUNTS,
		reservedRows: ACCOUNT_LIST_RESERVED_ROWS,
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
		accounts: OpenAICodexAccountView[],
		private readonly callbacks: OpenAICodexAccountSelectorCallbacks,
		private readonly options: OpenAICodexAccountSelectorOptions = {},
		probing = false,
	) {
		super();
		this.accounts = [...accounts];
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

	/** Swap in freshly probed accounts (e.g. after listAccounts resolves). */
	updateAccounts(accounts: OpenAICodexAccountView[], probing = false): void {
		this.accounts = [...accounts];
		this.probing = probing;
		const maxIndex = Math.max(0, this.accounts.length); // rows = accounts + add-account
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, maxIndex));
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
			if (this.rows.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.rows.length === 0) return;
			this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
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
		const target = this.rows[index];
		if (!target) return;
		if (target.type === "account") {
			this.callbacks.onSelect(target.account);
		} else {
			this.callbacks.onAddAccount();
		}
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
		if (!target) {
			return undefined;
		}
		this.selectedIndex = this.visibleStartIndex + childIndex;
		this.updateList();
		this.tui?.requestRender();
		this.activateRow(this.selectedIndex);
		return { consume: true };
	}

	private buildRowTargets(): RowTarget[] {
		return [...this.accounts.map((account): RowTarget => ({ type: "account", account })), { type: "add-account" }];
	}

	private buildRow(target: RowTarget, selected: boolean): MenuRow {
		if (target.type === "add-account") {
			return new MenuRow({
				primary: "Add new account",
				secondary: "Sign in with another ChatGPT subscription",
				meta: "OAuth",
				selected,
			});
		}
		const { account } = target;
		const activeMarker = account.active ? `${theme.fg("success", "●")} ` : "";
		return new MenuRow({
			primary: `${activeMarker}${getOpenAICodexAccountDisplayLabel(account)}`,
			secondary: formatAccountSecondary(account),
			meta: this.formatUsageMeta(account),
			selected,
		});
	}

	private formatUsageMeta(account: OpenAICodexAccountView): string {
		const usage = account.usage;
		if (!usage) {
			return theme.fg("muted", this.probing ? "checking…" : "usage unavailable");
		}
		if (usage.error) {
			return theme.fg("muted", "usage unavailable");
		}
		if (usage.limitReached || usage.allowed === false) {
			return theme.fg("warning", "exhausted");
		}
		if (typeof usage.remainingPercent === "number") {
			return theme.fg("success", `${Math.round(usage.remainingPercent)}% left`);
		}
		return theme.fg("muted", "usage unavailable");
	}

	private updateList(): void {
		this.rows = this.buildRowTargets();
		this.updateLayout();
		this.listContainer.clear();

		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.rows.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.rows.length);
		this.visibleStartIndex = startIndex;
		this.visibleTargets = this.rows.slice(startIndex, endIndex);

		for (let i = startIndex; i < endIndex; i++) {
			const target = this.rows[i];
			if (!target) continue;
			this.listContainer.addChild(this.buildRow(target, i === this.selectedIndex));
		}

		if (startIndex > 0 || endIndex < this.rows.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.rows.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
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
			preferredVisibleItems: PREFERRED_VISIBLE_ACCOUNTS,
			totalItems: this.rows.length,
			reservedRows: ACCOUNT_LIST_RESERVED_ROWS,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: ACCOUNT_SCROLL_INDICATOR_ROWS,
		});
	}
}

function formatAccountSecondary(account: OpenAICodexAccountView): string | undefined {
	const parts: string[] = [];
	const planType = account.usage?.planType;
	if (planType) {
		parts.push(planType.charAt(0).toUpperCase() + planType.slice(1));
	}
	const resetAt = account.usage?.resetAt;
	if (typeof resetAt === "number" && Number.isFinite(resetAt)) {
		parts.push(`resets ${new Date(resetAt).toLocaleString()}`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

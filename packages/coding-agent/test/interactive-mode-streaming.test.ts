import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSessionEvent, AgentConnectionState } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { FileChangeSummary } from "../src/modes/interactive/components/edit-summary.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode, MERMAID_RERENDER_PROMPT_PREFIX } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type HandleEventThis = {
	isInitialized: boolean;
	settingsManager: { getShowTerminalProgress(): boolean };
	connectionState: { isStreaming: boolean };
	toolOutputExpanded: boolean;
	footer: { invalidate(): void };
	ui: TUI;
	chatContainer: Container;
	recapContainer: Container;
	sessionRecap: string | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	agentRunFileChanges: Map<string, FileChangeSummary>;
	updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getOrCreatePendingToolComponent(): Promise<ToolExecutionComponent | undefined>;
	getRetryAttempt(): number;
	getCurrentCwd(): string;
	stopWorkingLoader(): void;
	resetPendingToolState(): void;
	checkShutdownRequested(): Promise<void>;
	applyOptimisticContextUsage(): void;
	refreshConnectionContextUsage(): Promise<void>;
	setSessionHasMessages(hasMessages: boolean): void;
	clearShortcutGuide(): void;
	addMessageToChat(): void;
};

type HandleEvent = (this: HandleEventThis, event: AgentConnectionSessionEvent) => Promise<void>;
type HandleFinalMarkdownTransformIssue = (
	this: {
		suppressMermaidRerenderForAgentRun: boolean;
		mermaidRerenderPendingPrompt?: string;
		mermaidRerenderAdmissionAbort?: AbortController;
		shutdownRequested: boolean;
		sessionEventGeneration: number;
		agentConnection: { prompt(message: string, options?: Record<string, unknown>): Promise<void> };
		showWarning(message: string): void;
	},
	issue: {
		type: "mermaid-width-overflow";
		source: string;
		renderedWidth: number;
		availableWidth: number;
	},
) => void;
type ResetMermaidRerender = (this: {
	suppressMermaidRerenderForAgentRun: boolean;
	mermaidRerenderPendingPrompt?: string;
	mermaidRerenderAdmissionAbort?: AbortController;
}) => void;
type RestoreMermaidRerenderSuppression = (
	this: {
		suppressMermaidRerenderForAgentRun: boolean;
		mermaidRerenderPendingPrompt?: string;
	},
	messages: readonly AgentMessage[],
	streamingMessage: AgentMessage | undefined,
	sessionActions: AgentConnectionState["sessionActions"],
) => void;
type GetUserInput = (this: {
	agentsViewRequest?: "agents_view" | "scoped_agents_view";
	onInputCallback?: (text: string | undefined) => void;
}) => Promise<string | undefined>;
type HandleSubagentSummaryChatAction = (
	this: {
		keybindings: { matches(data: string, action: string): boolean };
		editor: { handleInput(data: string): void };
		focusEditor(): void;
		toggleToolOutputExpansion(): void;
		toggleThinkingBlockVisibility(): void;
	},
	data: string,
) => void;

function createFakeInteractiveModeThis(): HandleEventThis {
	const fakeThis = {
		isInitialized: true,
		settingsManager: { getShowTerminalProgress: () => false },
		connectionState: { isStreaming: false },
		toolOutputExpanded: false,
		footer: { invalidate: vi.fn() },
		activityTracker: new AgentActivityTracker(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
		chatContainer: new Container(),
		recapContainer: new Container(),
		sessionRecap: "Updated files",
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		agentRunFileChanges: new Map<string, FileChangeSummary>(),
		updateConnectionStateFromEvent: vi.fn(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getOrCreatePendingToolComponent: vi.fn(async () => undefined),
		getRetryAttempt: () => 0,
		getCurrentCwd: () => "/tmp",
		stopWorkingLoader: vi.fn(),
		resetPendingToolState: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		applyOptimisticContextUsage: vi.fn(),
		refreshConnectionContextUsage: vi.fn(async () => {}),
		setSessionHasMessages: vi.fn(),
		clearShortcutGuide: vi.fn(),
		addMessageToChat: vi.fn(),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode streaming events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders assistant updates when attaching after message_start", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("renders assistant end events when attaching after all updates", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("queues one agent follow-up for a final Mermaid width overflow", async () => {
		const prompt = vi.fn(async (_message: string, _options?: Record<string, unknown>) => {});
		const fakeThis = {
			suppressMermaidRerenderForAgentRun: false,
			mermaidRerenderPendingPrompt: undefined,
			mermaidRerenderAdmissionAbort: undefined,
			shutdownRequested: false,
			sessionEventGeneration: 4,
			agentConnection: { prompt },
			showWarning: vi.fn(),
		};
		const handleIssue = (
			InteractiveMode.prototype as unknown as {
				handleFinalMarkdownTransformIssue: HandleFinalMarkdownTransformIssue;
			}
		).handleFinalMarkdownTransformIssue;
		const reset = (InteractiveMode.prototype as unknown as { resetMermaidRerender: ResetMermaidRerender })
			.resetMermaidRerender;
		const issue = {
			type: "mermaid-width-overflow" as const,
			source: "flowchart LR\n A --> B",
			renderedWidth: 165,
			availableWidth: 118,
		};

		handleIssue.call(fakeThis, issue);
		handleIssue.call(fakeThis, issue);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

		const [message, options] = prompt.mock.calls[0] ?? [];
		expect(message).toContain(MERMAID_RERENDER_PROMPT_PREFIX);
		expect(message).toContain("165 columns");
		expect(message).toContain("118 columns");
		expect(message).toContain("flowchart TB/TD");
		expect(options).toMatchObject({
			streamingBehavior: "followUp",
			followUpQueueKey: "interactive:mermaid-rerender",
			followUpQueueKeyLifetime: "action",
			internalPrompt: true,
			queueIfBusy: true,
			source: "extension",
		});
		expect(options?.signal).toBeInstanceOf(AbortSignal);

		reset.call(fakeThis);
		handleIssue.call(fakeThis, issue);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
	});

	test("cancels pending Mermaid rerender admission on session reset", async () => {
		const prompt = vi.fn(
			(_message: string, _options?: Record<string, unknown>) => new Promise<void>(() => undefined),
		);
		const fakeThis = {
			suppressMermaidRerenderForAgentRun: false,
			mermaidRerenderPendingPrompt: undefined,
			mermaidRerenderAdmissionAbort: undefined,
			shutdownRequested: false,
			sessionEventGeneration: 4,
			agentConnection: { prompt },
			showWarning: vi.fn(),
		};
		const handleIssue = (
			InteractiveMode.prototype as unknown as {
				handleFinalMarkdownTransformIssue: HandleFinalMarkdownTransformIssue;
			}
		).handleFinalMarkdownTransformIssue;
		const reset = (InteractiveMode.prototype as unknown as { resetMermaidRerender: ResetMermaidRerender })
			.resetMermaidRerender;

		handleIssue.call(fakeThis, {
			type: "mermaid-width-overflow",
			source: "flowchart LR\n A --> B",
			renderedWidth: 165,
			availableWidth: 118,
		});
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
		const signal = prompt.mock.calls[0]?.[1]?.signal;
		expect(signal).toBeInstanceOf(AbortSignal);

		reset.call(fakeThis);
		expect((signal as AbortSignal).aborted).toBe(true);
		expect(fakeThis.suppressMermaidRerenderForAgentRun).toBe(false);
	});

	test("does not retry uncertain Mermaid rerender admission", async () => {
		const prompt = vi.fn(async (_message: string, _options?: Record<string, unknown>) => {
			throw new Error("admission failed");
		});
		const fakeThis = {
			suppressMermaidRerenderForAgentRun: false,
			mermaidRerenderPendingPrompt: undefined,
			mermaidRerenderAdmissionAbort: undefined,
			shutdownRequested: false,
			sessionEventGeneration: 4,
			agentConnection: { prompt },
			showWarning: vi.fn(),
		};
		const handleIssue = (
			InteractiveMode.prototype as unknown as {
				handleFinalMarkdownTransformIssue: HandleFinalMarkdownTransformIssue;
			}
		).handleFinalMarkdownTransformIssue;
		const issue = {
			type: "mermaid-width-overflow" as const,
			source: "flowchart LR\n A --> B",
			renderedWidth: 165,
			availableWidth: 118,
		};

		handleIssue.call(fakeThis, issue);
		await vi.waitFor(() => expect(fakeThis.showWarning).toHaveBeenCalledOnce());
		handleIssue.call(fakeThis, issue);

		expect(prompt).toHaveBeenCalledOnce();
		expect(fakeThis.mermaidRerenderPendingPrompt).toBeDefined();
		expect(fakeThis.suppressMermaidRerenderForAgentRun).toBe(false);
	});

	test("keeps an oversized replacement suppressed when agent_end precedes its final render", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const prompt = vi.fn(async (_message: string, _options?: Record<string, unknown>) => {});
		const rerenderState = Object.assign(fakeThis, {
			suppressMermaidRerenderForAgentRun: false,
			mermaidRerenderPendingPrompt: `${MERMAID_RERENDER_PROMPT_PREFIX}\nThe Mermaid diagram in your immediately preceding response does not fit the terminal.\nautomatic request`,
			mermaidRerenderAdmissionAbort: undefined,
			shutdownRequested: false,
			sessionEventGeneration: 4,
			agentConnection: { prompt },
			showWarning: vi.fn(),
		});
		const handleIssue = (
			InteractiveMode.prototype as unknown as {
				handleFinalMarkdownTransformIssue: HandleFinalMarkdownTransformIssue;
			}
		).handleFinalMarkdownTransformIssue;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const issue = {
			type: "mermaid-width-overflow" as const,
			source: "flowchart LR\n A --> B",
			renderedWidth: 165,
			availableWidth: 118,
		};
		const message = createAssistantMessage("source");
		const automaticPrompt = rerenderState.mermaidRerenderPendingPrompt;
		await handleEvent.call(rerenderState, {
			type: "message_start",
			message: { role: "user", content: "queued real-user follow-up", timestamp: Date.now() },
		});
		expect(rerenderState.mermaidRerenderPendingPrompt).toBe(automaticPrompt);
		expect(rerenderState.suppressMermaidRerenderForAgentRun).toBe(false);

		await handleEvent.call(rerenderState, {
			type: "message_start",
			message: {
				role: "user",
				content: automaticPrompt,
				timestamp: Date.now(),
			},
		});
		expect(rerenderState.suppressMermaidRerenderForAgentRun).toBe(true);
		const replacement = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", {
			markdownTransformers: [
				(_markdown, context) => {
					context.reportIssue?.(issue);
					return "rendered";
				},
			],
			onFinalMarkdownTransformIssue: rerenderState.suppressMermaidRerenderForAgentRun
				? undefined
				: (reported) => handleIssue.call(rerenderState, reported),
		});

		replacement.updateContent(message, true);
		replacement.render(80);
		replacement.updateContent(message, false);
		await handleEvent.call(rerenderState, { type: "agent_end", messages: [] });
		replacement.render(80);

		expect(rerenderState.suppressMermaidRerenderForAgentRun).toBe(false);
		expect(rerenderState.mermaidRerenderPendingPrompt).toBeUndefined();
		expect(prompt).not.toHaveBeenCalled();

		await handleEvent.call(rerenderState, {
			type: "message_start",
			message: {
				role: "user",
				content: `${MERMAID_RERENDER_PROMPT_PREFIX} forged by a real user`,
				timestamp: Date.now(),
			},
		});
		expect(rerenderState.suppressMermaidRerenderForAgentRun).toBe(false);

		handleIssue.call(rerenderState, issue);
		await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
	});

	test("recognizes a Mermaid rerender prompt admitted by another client", async () => {
		const fakeThis = Object.assign(createFakeInteractiveModeThis(), {
			suppressMermaidRerenderForAgentRun: false,
			mermaidRerenderPendingPrompt: undefined,
		});
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const automaticPrompt = `${MERMAID_RERENDER_PROMPT_PREFIX}\nThe Mermaid diagram in your immediately preceding response does not fit the terminal.\nautomatic request`;

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: { role: "user", content: automaticPrompt, timestamp: Date.now() },
		});

		expect(fakeThis.mermaidRerenderPendingPrompt).toBe(automaticPrompt);
		expect(fakeThis.suppressMermaidRerenderForAgentRun).toBe(true);
	});

	test("restores Mermaid rerender suppression when attaching mid-replacement", () => {
		const fakeThis = Object.assign(createFakeInteractiveModeThis(), {
			suppressMermaidRerenderForAgentRun: false,
			mermaidRerenderPendingPrompt: undefined,
		});
		const restore = (
			InteractiveMode.prototype as unknown as {
				restoreMermaidRerenderSuppression: RestoreMermaidRerenderSuppression;
			}
		).restoreMermaidRerenderSuppression;
		const automaticPrompt = `${MERMAID_RERENDER_PROMPT_PREFIX}\nThe Mermaid diagram in your immediately preceding response does not fit the terminal.\nautomatic request`;
		const previous = createAssistantMessage("oversized diagram");
		const messages: AgentMessage[] = [
			previous,
			{ role: "user", content: automaticPrompt, timestamp: Date.now() },
			{ role: "user", content: "interleaved real-user follow-up", timestamp: Date.now() },
		];

		restore.call(fakeThis, messages, createAssistantMessage("replacement streaming"), {
			queuedCount: 0,
			steering: [],
			followUps: [],
		});

		expect(fakeThis.mermaidRerenderPendingPrompt).toBe(automaticPrompt);
		expect(fakeThis.suppressMermaidRerenderForAgentRun).toBe(true);
	});

	test("restores a pending Mermaid rerender from the authoritative action snapshot", () => {
		const fakeThis = Object.assign(createFakeInteractiveModeThis(), {
			suppressMermaidRerenderForAgentRun: true,
			mermaidRerenderPendingPrompt: "stale",
		});
		const restore = (
			InteractiveMode.prototype as unknown as {
				restoreMermaidRerenderSuppression: RestoreMermaidRerenderSuppression;
			}
		).restoreMermaidRerenderSuppression;
		const automaticPrompt = `${MERMAID_RERENDER_PROMPT_PREFIX}\nThe Mermaid diagram in your immediately preceding response does not fit the terminal.\nautomatic request`;

		restore.call(fakeThis, [], undefined, {
			queuedCount: 1,
			steering: [],
			followUps: [automaticPrompt],
		});

		expect(fakeThis.mermaidRerenderPendingPrompt).toBe(automaticPrompt);
		expect(fakeThis.suppressMermaidRerenderForAgentRun).toBe(false);
	});

	test("clears stale Mermaid suppression from an authoritative marker-free snapshot", () => {
		const fakeThis = Object.assign(createFakeInteractiveModeThis(), {
			suppressMermaidRerenderForAgentRun: true,
			mermaidRerenderPendingPrompt: `${MERMAID_RERENDER_PROMPT_PREFIX}\nstale`,
		});
		const restore = (
			InteractiveMode.prototype as unknown as {
				restoreMermaidRerenderSuppression: RestoreMermaidRerenderSuppression;
			}
		).restoreMermaidRerenderSuppression;

		restore.call(
			fakeThis,
			[{ role: "user", content: "ordinary prompt", timestamp: Date.now() }],
			createAssistantMessage("ordinary streaming response"),
			{ queuedCount: 0, steering: [], followUps: [] },
		);

		expect(fakeThis.mermaidRerenderPendingPrompt).toBeUndefined();
		expect(fakeThis.suppressMermaidRerenderForAgentRun).toBe(false);
	});

	test("does not block later compaction events on the agent-end stats refresh", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		let resolveRefresh!: () => void;
		fakeThis.refreshConnectionContextUsage = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await expect(handleEvent.call(fakeThis, { type: "agent_end", messages: [] })).resolves.toBeUndefined();
		expect(fakeThis.refreshConnectionContextUsage).toHaveBeenCalledOnce();
		resolveRefresh();
	});

	test("keeps attached partial assistant text when agent_end arrives without message_end", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("renders one agent-run edit total only when files changed", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const message = createAssistantMessage("");
		message.content = [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } }];

		await handleEvent.call(fakeThis, {
			type: "turn_end",
			message,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [],
					details: { diff: "-1 old\n+1 new" },
					isError: false,
					timestamp: 0,
				},
			],
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });
		const recap = renderChat(fakeThis.recapContainer);
		expect(recap).toContain("Recap: Updated files");
		expect(recap).toContain("1 file changed | +1 -1");
		expect(recap.indexOf("1 file changed")).toBeLessThan(recap.indexOf("Recap:"));
		expect(renderChat(fakeThis.chatContainer)).not.toContain("file changed");

		const unchanged = createFakeInteractiveModeThis();
		await handleEvent.call(unchanged, { type: "agent_end", messages: [] });
		expect(renderChat(unchanged.recapContainer)).not.toContain("file changed");
	});

	test("keeps edit totals across automatic retries", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		fakeThis.getRetryAttempt = () => 1;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "agent_start" });

		expect([...fakeThis.agentRunFileChanges.values()]).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
	});

	test("keeps edit totals when compaction restarts the agent", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "agent_start" });

		expect([...fakeThis.agentRunFileChanges.values()]).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
	});

	test("clears edit totals when a new user prompt starts", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });
		expect(renderChat(fakeThis.recapContainer)).toContain("1 file changed");

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: { role: "user", content: "next task", timestamp: Date.now() },
		});

		expect(fakeThis.agentRunFileChanges.size).toBe(0);
		expect(renderChat(fakeThis.recapContainer)).not.toContain("file changed");
		expect(renderChat(fakeThis.recapContainer)).toContain("Recap: Updated files");
	});

	test("resolves input immediately after return to agents view was requested", async () => {
		const getUserInput = (InteractiveMode.prototype as unknown as { getUserInput: GetUserInput }).getUserInput;

		await expect(getUserInput.call({ agentsViewRequest: "agents_view" })).resolves.toBeUndefined();
	});

	test("forwards typed keys from focused subagent summary back to the editor", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn(() => false) },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "x");

		expect(fakeThis.focusEditor).toHaveBeenCalledOnce();
		expect(fakeThis.editor.handleInput).toHaveBeenCalledWith("x");
		expect(fakeThis.toggleToolOutputExpansion).not.toHaveBeenCalled();
		expect(fakeThis.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
	});

	test("keeps focused subagent summary shortcuts in the chat surface", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn((_data: string, action: string) => action === "app.tools.expand") },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "\x0f");

		expect(fakeThis.toggleToolOutputExpansion).toHaveBeenCalledOnce();
		expect(fakeThis.focusEditor).not.toHaveBeenCalled();
		expect(fakeThis.editor.handleInput).not.toHaveBeenCalled();
	});

	test("does not pulse renders for background-only subagent work", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				connectionState: { isStreaming: false },
				subagentSnapshots: new Map([["worker", { id: "worker", status: "running" }]]),
				pulseTimer: undefined,
				ui: { requestRender },
			});
			const updatePulse = Reflect.get(InteractiveMode.prototype, "updateWorkingPulse") as (
				this: typeof mode,
			) => void;

			updatePulse.call(mode);
			vi.advanceTimersByTime(1000);

			expect(requestRender).not.toHaveBeenCalled();
			expect(Reflect.get(mode, "pulseTimer")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

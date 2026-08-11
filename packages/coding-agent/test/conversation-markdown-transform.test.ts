import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("replayed conversation Markdown transforms", () => {
	beforeAll(() => initTheme("dark"));

	it("wires built-in transforms to assistant and user components", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "user source", timestamp: Date.now() },
			fauxAssistantMessage("assistant source"),
		];
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: process.cwd(),
			toolOptions: {},
			getToolDefinition: () => undefined,
			markdownTransformers: [(markdown, context) => `${context.messageType} transformed: ${markdown}`],
		});
		const rendered = stripAnsi(components.flatMap((component) => component.render(100)).join("\n"));

		expect(rendered).toContain("user transformed: user source");
		expect(rendered).toContain("assistant transformed: assistant source");
	});
});

import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";
import type { AgentConnectionSideQuestionEvent } from "../src/modes/agent-connection/types.js";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.js";
import { SideQuestionComponent } from "../src/modes/interactive/components/side-question.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function event(
	status: AgentConnectionSideQuestionEvent["status"],
	answer: string,
	id = "question-1",
	question = "Can you explain?",
): AgentConnectionSideQuestionEvent {
	return { id, question, answer, status };
}

function renderPlain(component: SideQuestionComponent, width = 100): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("SideQuestionComponent Markdown transforms", () => {
	test("re-renders a final-only Mermaid diagram when streaming completes", () => {
		initTheme("dark");
		const diagram = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";
		const transformer = createMermaidMarkdownTransformer({ getMode: () => "final", theme });
		const component = new SideQuestionComponent(event("running", diagram), 2, [transformer]);

		const streaming = renderPlain(component);
		expect(streaming).toContain("flowchart LR");
		expect(streaming).not.toContain("───▶");

		component.update(event("complete", diagram));
		const complete = renderPlain(component);
		expect(complete).toContain("───▶");
		expect(complete).not.toContain("flowchart LR");
	});

	test("transforms follow-up questions with user context", () => {
		initTheme("dark");
		const component = new SideQuestionComponent(event("complete", "first answer"), 2, [
			(markdown, context) => (context.messageType === "user" ? `transformed: ${markdown}` : markdown),
		]);
		component.addTurn(event("running", "", "question-2", "follow-up question"));

		expect(renderPlain(component)).toContain("transformed: follow-up question");
	});
});

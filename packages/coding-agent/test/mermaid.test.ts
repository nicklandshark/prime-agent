import { describe, expect, it } from "vitest";
import type { MermaidRenderingMode } from "../src/core/settings-manager.js";
import type { MarkdownTransformContext } from "../src/modes/interactive/components/markdown-transform.js";
import { createMermaidMarkdownTransformer } from "../src/modes/interactive/components/mermaid.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	messageType?: MarkdownTransformContext["messageType"];
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transformer = createMermaidMarkdownTransformer({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transformer(markdown, {
		availableWidth: options.maxWidth ?? 100,
		isStreaming: options.isStreaming ?? false,
		messageType: options.messageType ?? "assistant",
	});
}

describe("Mermaid rendering", () => {
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered.includes("Before")).toBe(true);
		expect(rendered.includes("┌───────┐")).toBe(true);
		expect(rendered.includes("│ Start ├───▶│ Done │")).toBe(true);
		expect(rendered.includes("└───────┘    └──────┘`\nAfter")).toBe(true);
		expect(!rendered.includes("```mermaid")).toBe(true);
		expect(rendered.includes("After")).toBe(true);
	});

	it("leaves unsupported and oversized diagrams unchanged", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const oversized = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		expect(transformMermaid(oversized, { maxWidth: 10 })).toBe(oversized);
	});

	it("maps semantic spans and warnings through the theme", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as Theme;
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme });
		const warning = transformMermaid("```mermaid\ngraph TD; A-->\n```", { theme });

		expect(rendered.includes("<borderMuted>")).toBe(true);
		expect(rendered.includes("<accent>")).toBe(true);
		expect(warning.includes("<warning>Mermaid diagram not rendered:")).toBe(true);
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";
		expect(transformMermaid(partialMarkdown, { isStreaming: true }).includes("───▶")).toBe(true);
	});

	it("falls back to the code block with a warning only after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final.includes(markdown)).toBe(true);
		expect(final.includes("```\n`Mermaid diagram not rendered")).toBe(true);
		expect(final.includes('dropped, expected a link: ":::highlight --> B[Bar]"')).toBe(true);
		expect(followedByText.includes("  \nFollowing text")).toBe(true);
		expect(!streaming.includes("Mermaid diagram not rendered")).toBe(true);
		expect(!streaming.includes("```mermaid")).toBe(true);
		expect(streaming.includes("│ Foo │")).toBe(true);
	});

	it("summarizes additional warnings", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo]:::highlight --> B[Bar]\n  C[Baz]:::other --> D[Qux]\n```";
		const rendered = transformMermaid(markdown);

		expect(rendered.includes(markdown)).toBe(true);
		expect(rendered.includes('dropped, expected a link: ":::highlight --> B[Bar]"')).toBe(true);
		expect(rendered.includes("(+1 more)")).toBe(true);
		expect(!rendered.includes('dropped, expected a link: ":::other --> D[Qux]"')).toBe(true);
	});

	it("respects rendering modes and skips thinking blocks", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(!transformMermaid(markdown, { mode: "final" }).includes("```mermaid")).toBe(true);
		expect(transformMermaid(markdown, { messageType: "assistant-thinking" })).toBe(markdown);
	});
});

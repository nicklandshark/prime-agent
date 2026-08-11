import { type MermaidArt, render, type Span } from "grok-mermaid";
import { Marked, type Token } from "marked";
import type { MermaidRenderingMode } from "../../../core/settings-manager.js";
import type { Theme } from "../theme/theme.js";
import type { MarkdownTransformer } from "./markdown-transform.js";

const markdownParser = new Marked();

interface MermaidTransformerOptions {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}

function isMermaid(token: Token): token is Token & { type: "code"; raw: string; text: string; lang?: string } {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function hasClosingFence(raw: string): boolean {
	const lines = raw.replaceAll("\r\n", "\n").split("\n");
	const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
	if (!opening) return false;
	const fence = opening[1];
	const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*$`);
	return lines.slice(1).some((line) => closing.test(line));
}

function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

/** Replace top-level Mermaid code blocks with width-safe Unicode terminal diagrams. */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	return (markdown, context) => {
		const mode = options.getMode();
		if (
			mode === "off" ||
			context.messageType === "assistant-thinking" ||
			(context.isStreaming && mode !== "streaming")
		) {
			return markdown;
		}

		return markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = render(token.text);
				if (!art) return token.raw;
				if (art.width > context.availableWidth) {
					if (
						!context.isStreaming &&
						context.messageType === "assistant" &&
						art.warnings.length === 0 &&
						hasClosingFence(token.raw)
					) {
						context.reportIssue?.({
							type: "mermaid-width-overflow",
							source: token.text,
							renderedWidth: art.width,
							availableWidth: context.availableWidth,
						});
					}
					return token.raw;
				}
				if (!context.isStreaming && art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
	};
}

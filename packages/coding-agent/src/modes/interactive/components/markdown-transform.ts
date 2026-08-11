export interface MermaidWidthOverflow {
	type: "mermaid-width-overflow";
	source: string;
	renderedWidth: number;
	availableWidth: number;
}

export type MarkdownTransformIssue = MermaidWidthOverflow;

export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
	reportIssue?: (issue: MarkdownTransformIssue) => void;
}

export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
	reportIssue?: (issue: MarkdownTransformIssue) => void,
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth, reportIssue }, transformers);
}

export function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// A display transformer must never break the interactive transcript.
		}
	}
	return transformedMarkdown;
}

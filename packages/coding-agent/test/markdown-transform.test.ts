import { describe, expect, it } from "vitest";
import {
	applyMarkdownTransformers,
	createMarkdownTransform,
	type MarkdownTransformContext,
} from "../src/modes/interactive/components/markdown-transform.js";

const context: MarkdownTransformContext = {
	messageType: "assistant",
	isStreaming: true,
	availableWidth: 42,
};

describe("Markdown transformers", () => {
	it("applies transforms in order with the supplied context", () => {
		const seen: MarkdownTransformContext[] = [];
		const result = applyMarkdownTransformers("start", context, [
			(markdown, received) => {
				seen.push(received);
				return `${markdown}-one`;
			},
			(markdown) => `${markdown}-two`,
		]);

		expect(result).toBe("start-one-two");
		expect(seen).toEqual([context]);
	});

	it("isolates transformer failures", () => {
		const result = applyMarkdownTransformers("safe", context, [
			() => {
				throw new Error("broken display transform");
			},
			(markdown) => `${markdown}-after`,
		]);
		expect(result).toBe("safe-after");
	});

	it("creates a width-aware transform for a message state", () => {
		const transform = createMarkdownTransform("user", false, [
			(markdown, received) =>
				`${markdown}:${received.messageType}:${received.isStreaming}:${received.availableWidth}`,
		]);
		expect(transform("text", 18)).toBe("text:user:false:18");
	});
});

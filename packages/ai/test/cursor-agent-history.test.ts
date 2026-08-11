import { describe, expect, it } from "vitest";
import { buildCursorHistoryForTest, buildCursorSystemPromptJsons } from "../src/providers/cursor-agent/index.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../src/types.js";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: "cursor-agent",
		provider: "cursor-agent",
		model: "kimi-k3-max",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

describe("Cursor Agent state replay", () => {
	it("encodes ordered system prompts as independently cacheable blobs", () => {
		expect(buildCursorSystemPromptJsons(["stable prefix", "changing suffix"])).toEqual([
			JSON.stringify({ role: "system", content: "stable prefix" }),
			JSON.stringify({ role: "system", content: "changing suffix" }),
		]);
		expect(buildCursorSystemPromptJsons("one prompt")).toEqual([
			JSON.stringify({ role: "system", content: "one prompt" }),
		]);
	});

	it("replays prior text, Kimi reasoning, tool calls, and paired results in both history structures", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "lookup",
			content: [{ type: "text", text: "tool output" }],
			isError: false,
			timestamp: 3,
		};
		const messages: Message[] = [
			{ role: "user", content: "prior question", timestamp: 1 },
			assistant([
				{ type: "thinking", thinking: "private plan", thinkingSignature: "sig" },
				{ type: "text", text: "I will look it up." },
				{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "needle" } },
			]),
			result,
			{ role: "user", content: "active question", timestamp: 4 },
		];

		const history = buildCursorHistoryForTest(messages, 3, "kimi-k3-max");
		expect(history.rootPromptMessagesJson.map((item: any) => item.role)).toEqual(["user", "assistant", "tool"]);
		expect(history.rootPromptMessagesJson[1]).toMatchObject({
			role: "assistant",
			content: expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", text: "private plan", signature: "sig" }),
				expect.objectContaining({ type: "tool-call", toolCallId: "call-1", toolName: "lookup" }),
			]),
		});
		expect(history.turnUserMessagesJson).toHaveLength(1);
		expect(history.turnStepMessagesJson[0]).toHaveLength(3);
	});
});

import { describe, expect, it } from "vitest";
import { buildCursorHistoryForTest, buildCursorSystemPromptJsons } from "../src/providers/cursor-agent/index.js";
import type { AssistantMessage, Message, ToolResultMessage } from "../src/types.js";

function assistant(content: AssistantMessage["content"], model = "kimi-k3-max"): AssistantMessage {
	return {
		role: "assistant",
		api: "cursor-agent",
		provider: "cursor-agent",
		model,
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

	it("replays a low→high→max routed Kimi K3 sequence as one logical model", () => {
		const messages: Message[] = [
			{ role: "user", content: "first question", timestamp: 1 },
			assistant(
				[
					{ type: "thinking", thinking: "low-effort plan", thinkingSignature: "sig-low" },
					{ type: "text", text: "first answer" },
				],
				"kimi-k3-low",
			),
			{ role: "user", content: "second question", timestamp: 3 },
			assistant(
				[
					{ type: "thinking", thinking: "high-effort plan", thinkingSignature: "sig-high" },
					{ type: "text", text: "second answer" },
				],
				"kimi-k3-high",
			),
			{ role: "user", content: "active question", timestamp: 5 },
		];

		// The active request targets the max route; history was persisted under
		// the low/high route ids of the same logical Kimi K3 model.
		const history = buildCursorHistoryForTest(messages, 4, "kimi-k3-max");
		expect(history.rootPromptMessagesJson.map((item: any) => item.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(history.rootPromptMessagesJson[1]).toMatchObject({
			role: "assistant",
			content: expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", text: "low-effort plan", signature: "sig-low" }),
			]),
		});
		expect(history.rootPromptMessagesJson[3]).toMatchObject({
			role: "assistant",
			content: expect.arrayContaining([
				expect.objectContaining({ type: "reasoning", text: "high-effort plan", signature: "sig-high" }),
			]),
		});
		expect(history.turnStepMessagesJson).toHaveLength(2);
		expect(history.turnStepMessagesJson[0]).toHaveLength(2);
		expect(history.turnStepMessagesJson[1]).toHaveLength(2);
	});

	it("replays logical-model history when the active request targets a route id", () => {
		const messages: Message[] = [
			{ role: "user", content: "prior question", timestamp: 1 },
			assistant([
				{ type: "thinking", thinking: "persisted plan", thinkingSignature: "sig" },
				{ type: "text", text: "answer" },
			]),
			{ role: "user", content: "active question", timestamp: 3 },
		];

		const history = buildCursorHistoryForTest(messages, 2, "kimi-k3-low");
		expect(history.rootPromptMessagesJson[1]).toMatchObject({
			role: "assistant",
			content: expect.arrayContaining([expect.objectContaining({ type: "reasoning", text: "persisted plan" })]),
		});
		expect(history.turnStepMessagesJson[0]).toHaveLength(2);
	});

	it("still rejects genuinely foreign models in Kimi K3 history", () => {
		const messages: Message[] = [
			{ role: "user", content: "prior question", timestamp: 1 },
			assistant([{ type: "text", text: "grok answer" }], "cursor-grok-4.5-high"),
			{ role: "user", content: "active question", timestamp: 3 },
		];

		expect(() => buildCursorHistoryForTest(messages, 2, "kimi-k3-max")).toThrow(/different model/);
	});
});

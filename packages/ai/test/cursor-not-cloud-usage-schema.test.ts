import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/index.js";
import {
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	InteractionQuerySchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "../src/providers/cursor-not-cloud/agent_pb.js";
import {
	calculateCursorAgentUsageCost,
	handleConversationCheckpointUpdate,
	processInteractionUpdate,
} from "../src/providers/cursor-not-cloud/index.js";
import type { AssistantMessage, Usage } from "../src/types.js";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("cursor-not-cloud current schema and usage", () => {
	it("pins the schema-matched terminal, checkpoint, server, request, update, and query fields", () => {
		expect(TurnEndedUpdateSchema.fields.map((field) => [field.number, field.name])).toEqual([
			[1, "input_tokens"],
			[2, "output_tokens"],
			[3, "cache_read_tokens"],
			[4, "cache_write_tokens"],
			[5, "reasoning_tokens"],
		]);
		expect(ConversationTokenDetailsSchema.fields.map((field) => field.number)).toEqual([1, 2, 3, 4, 5]);
		expect(
			AgentServerMessageSchema.fields.some((field) => field.number === 8 && field.name === "ttft_breakdown"),
		).toBe(true);
		expect(AgentRunRequestSchema.fields.at(-1)?.number).toBe(28);
		expect(InteractionUpdateSchema.fields.slice(-7).map((field) => field.number)).toEqual([
			18, 19, 20, 21, 22, 23, 24,
		]);
		expect(InteractionQuerySchema.fields.filter((field) => field.number >= 9).map((field) => field.number)).toEqual([
			9, 10, 11, 12, 13, 14,
		]);
	});

	it("uses terminal counters authoritatively while retaining occupied context independently", () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-not-cloud",
			provider: "cursor-not-cloud",
			model: "cursor-grok-4.5-high",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const usageState = { sawTokenDelta: true };
		const terminal = create(InteractionUpdateSchema, {
			message: {
				case: "turnEnded",
				value: create(TurnEndedUpdateSchema, {
					inputTokens: 11161n,
					outputTokens: 23n,
					cacheReadTokens: 0n,
					cacheWriteTokens: 0n,
					reasoningTokens: 0n,
				}),
			},
		});
		processInteractionUpdate(terminal, output, { push() {} } as never, {} as never, usageState);
		handleConversationCheckpointUpdate(
			create(ConversationStateStructureSchema, {
				tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 11184, maxTokens: 256000 }),
			}),
			output,
		);
		expect(output.usage).toMatchObject({
			input: 11161,
			output: 23,
			contextTokens: 11184,
			contextMaxTokens: 256000,
			totalTokens: 11184,
		});
		const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high");
		if (!model) throw new Error("model missing");
		calculateCursorAgentUsageCost(model, "cursor-grok-4.5-high", output.usage);
		expect(output.usage.cost.input).toBeCloseTo((11161 * 2) / 1_000_000);
		expect(output.usage.cost.output).toBeCloseTo((23 * 6) / 1_000_000);
	});
});

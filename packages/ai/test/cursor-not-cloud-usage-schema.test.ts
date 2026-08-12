import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
	it("keeps the exact OMP v17.2.15 schema plus only the five independent terminal counters", () => {
		expect(TurnEndedUpdateSchema.fields.map((field) => [field.number, field.name])).toEqual([
			[1, "input_tokens"],
			[2, "output_tokens"],
			[3, "cache_read_tokens"],
			[4, "cache_write_tokens"],
			[5, "reasoning_tokens"],
		]);
		expect(ConversationTokenDetailsSchema.fields.map((field) => field.number)).toEqual([1, 2]);
		expect(AgentServerMessageSchema.fields.map((field) => field.number)).toEqual([1, 2, 5, 3, 4, 7]);
		expect(AgentRunRequestSchema.fields.at(-1)?.number).toBe(8);
		expect(InteractionUpdateSchema.fields.at(-1)?.number).toBe(17);
		expect(InteractionQuerySchema.fields.map((field) => field.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

		const proto = readFileSync(new URL("../src/providers/cursor-not-cloud/agent.proto", import.meta.url), "utf8");
		const extension = `// Independently specified wire extension used by this provider. These five
// scalar counters are factual terminal field declarations observed by the
// project; no other declaration in this file is copied from Cursor software.
message TurnEndedUpdate {
   optional int64 input_tokens = 1;
   optional int64 output_tokens = 2;
   optional int64 cache_read_tokens = 3;
   optional int64 cache_write_tokens = 4;
   optional int64 reasoning_tokens = 5;
}`;
		const exactOmpBaseline = proto.replace(extension, "message TurnEndedUpdate {\n}");
		expect(createHash("sha256").update(exactOmpBaseline).digest("hex")).toBe(
			"aa6d1715e8ba8309c9049d3d1d9acbea75454f852a82ff22292843c1010ae527",
		);
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
					cacheWriteTokens: 5n,
					reasoningTokens: 7n,
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
			cacheWrite: 5,
			reasoning: 7,
			totalTokens: 11189,
		});
		const model = getModel("cursor-not-cloud", "cursor-grok-4.5-high");
		if (!model) throw new Error("model missing");
		calculateCursorAgentUsageCost(model, "cursor-grok-4.5-high", output.usage);
		expect(output.usage.cost.input).toBeCloseTo((11161 * 2) / 1_000_000);
		expect(output.usage.cost.output).toBeCloseTo((23 * 6) / 1_000_000);
	});
});

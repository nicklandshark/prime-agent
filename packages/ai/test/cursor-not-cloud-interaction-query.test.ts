import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AskQuestionInteractionQuerySchema,
	CreatePlanRequestQuerySchema,
	ExaFetchRequestQuerySchema,
	ExaSearchRequestQuerySchema,
	InteractionQuerySchema,
	SetupVmEnvironmentArgsSchema,
	SwitchModeRequestQuerySchema,
	WebSearchRequestQuerySchema,
} from "../src/providers/cursor-not-cloud/agent_pb.js";
import { handleInteractionQuery } from "../src/providers/cursor-not-cloud/index.js";

function decodeResponse(query: ReturnType<typeof create<typeof InteractionQuerySchema>>): AgentClientMessage {
	let written: Buffer | undefined;
	const request = {
		write(chunk: Buffer) {
			written = chunk;
			return true;
		},
		closed: false,
		destroyed: false,
		writableLength: 0,
	} as unknown as Parameters<typeof handleInteractionQuery>[1];
	handleInteractionQuery(query, request);
	if (!written) throw new Error("query handler did not write a response");
	const length = written.readUInt32BE(1);
	return fromBinary(AgentClientMessageSchema, written.subarray(5, 5 + length));
}

function rawUnknownQuery(fieldNo: number): ReturnType<typeof create<typeof InteractionQuerySchema>> {
	const bytes = Uint8Array.of(8, 1, (fieldNo << 3) | 2, 0);
	return fromBinary(InteractionQuerySchema, bytes);
}

describe("Cursor interaction query bridge", () => {
	it.each([
		["webSearchRequestQuery", WebSearchRequestQuerySchema, "webSearchRequestResponse"],
		["askQuestionInteractionQuery", AskQuestionInteractionQuerySchema, "askQuestionInteractionResponse"],
		["switchModeRequestQuery", SwitchModeRequestQuerySchema, "switchModeRequestResponse"],
		["createPlanRequestQuery", CreatePlanRequestQuerySchema, "createPlanRequestResponse"],
		["exaSearchRequestQuery", ExaSearchRequestQuerySchema, "exaSearchRequestResponse"],
		["exaFetchRequestQuery", ExaFetchRequestQuerySchema, "exaFetchRequestResponse"],
	] as const)("answers MIT-baseline %s with a populated typed rejection", (queryCase, schema, responseCase) => {
		const response = decodeResponse(
			create(InteractionQuerySchema, { id: 41, query: { case: queryCase, value: create(schema, {}) } as never }),
		);
		expect(response.message.case).toBe("interactionResponse");
		if (response.message.case !== "interactionResponse") throw new Error("wrong response envelope");
		expect(response.message.value.result.case).toBe(responseCase);
	});

	it("fails rather than falsely claiming local VM setup succeeded", () => {
		expect(() =>
			decodeResponse(
				create(InteractionQuerySchema, {
					id: 42,
					query: { case: "setupVmEnvironmentArgs", value: create(SetupVmEnvironmentArgsSchema, {}) },
				}),
			),
		).toThrow(/cannot truthfully perform/i);
	});

	it.each([9, 10, 11, 12, 13, 14])("fails closed for independently unspecified query field %i", (fieldNo) => {
		const query = rawUnknownQuery(fieldNo);
		expect(query.query.case).toBeUndefined();
		expect(() => decodeResponse(query)).toThrow(/unknown interaction query variant/i);
	});
});

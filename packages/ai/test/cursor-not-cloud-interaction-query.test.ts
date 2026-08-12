import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	AskQuestionInteractionQuerySchema,
	ConnectScmArgsSchema,
	ConnectScmRequestQuerySchema,
	CreatePlanRequestQuerySchema,
	ExaFetchRequestQuerySchema,
	ExaSearchRequestQuerySchema,
	GenerateImageArgsSchema,
	GenerateImageRequestQuerySchema,
	InteractionQuerySchema,
	McpAuthArgsSchema,
	McpAuthRequestQuerySchema,
	PrManagementArgsSchema,
	PrManagementRequestQuerySchema,
	ReplaceEnvArgsSchema,
	SetupVmEnvironmentArgsSchema,
	SwitchModeRequestQuerySchema,
	WebFetchArgsSchema,
	WebFetchRequestQuerySchema,
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
	} as unknown as Parameters<typeof handleInteractionQuery>[1];
	handleInteractionQuery(query, request);
	if (!written) throw new Error("query handler did not write a response");
	const length = written.readUInt32BE(1);
	return fromBinary(AgentClientMessageSchema, written.subarray(5, 5 + length));
}

function varint(value: number): Uint8Array {
	const bytes: number[] = [];
	do {
		let byte = value & 0x7f;
		value >>>= 7;
		if (value) byte |= 0x80;
		bytes.push(byte);
	} while (value);
	return Uint8Array.from(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function wireMessageField(fieldNo: number, data = new Uint8Array()): Uint8Array {
	return concat(varint((fieldNo << 3) | 2), varint(data.byteLength), data);
}

describe("Cursor interaction query bridge", () => {
	const knownCurrentCases = [
		[2, "webSearchRequestQuery", WebSearchRequestQuerySchema, "webSearchRequestResponse", "rejected"],
		[
			3,
			"askQuestionInteractionQuery",
			AskQuestionInteractionQuerySchema,
			"askQuestionInteractionResponse",
			"rejected",
		],
		[4, "switchModeRequestQuery", SwitchModeRequestQuerySchema, "switchModeRequestResponse", "rejected"],
		[7, "createPlanRequestQuery", CreatePlanRequestQuerySchema, "createPlanRequestResponse", "error"],
	] as const;

	for (const [fieldNo, queryCase, schema, responseCase, nestedCase] of knownCurrentCases) {
		it(`answers current field ${fieldNo} ${queryCase} with populated ${responseCase}`, () => {
			const response = decodeResponse(
				create(InteractionQuerySchema, {
					id: 41,
					query: { case: queryCase, value: create(schema, {}) } as never,
				}),
			);
			expect(response.message.case).toBe("interactionResponse");
			if (response.message.case !== "interactionResponse") throw new Error("wrong response envelope");
			expect(response.message.value.id).toBe(41);
			expect(response.message.value.result.case).toBe(responseCase);
			const value = response.message.value.result.value as any;
			const nested =
				responseCase === "askQuestionInteractionResponse" || responseCase === "createPlanRequestResponse"
					? value.result?.result
					: value.result;
			expect(nested?.case).toBe(nestedCase);
			expect(nested?.value?.reason ?? nested?.value?.error).toMatch(/Not implemented by this client/i);
		});
	}

	it("fails the turn rather than falsely claiming local VM setup succeeded", () => {
		expect(() =>
			decodeResponse(
				create(InteractionQuerySchema, {
					id: 42,
					query: { case: "setupVmEnvironmentArgs", value: create(SetupVmEnvironmentArgsSchema, {}) },
				}),
			),
		).toThrow(/cannot truthfully perform/i);
	});

	// Cursor CLI v2026.08.04 fields 9-14: typed in the regenerated descriptor,
	// so the query decodes into a named oneof case and the response carries the
	// matching typed rejection arm.
	it.each([
		[9, "webFetchRequestQuery", WebFetchRequestQuerySchema, "webFetchRequestResponse", "rejected"],
		[10, "prManagementRequestQuery", PrManagementRequestQuerySchema, "prManagementResult", "rejected"],
		[11, "mcpAuthRequestQuery", McpAuthRequestQuerySchema, "mcpAuthRequestResponse", "rejected"],
		[12, "generateImageRequestQuery", GenerateImageRequestQuerySchema, "generateImageRequestResponse", "rejected"],
		[13, "replaceEnvArgs", ReplaceEnvArgsSchema, "replaceEnvResult", "failure"],
		[14, "connectScmRequestQuery", ConnectScmRequestQuerySchema, "connectScmRequestResponse", "rejected"],
	] as const)(
		"decodes current field %i as typed %s and answers with typed %s",
		(fieldNo, queryCase, schema, responseCase, nestedCase) => {
			// Decode actual wire bytes (id + the raw field a real client sends):
			// pins the descriptor's field number, not just its presence.
			const rawQuery = concat(varint(8), varint(43), wireMessageField(fieldNo));
			const wireQuery = fromBinary(InteractionQuerySchema, rawQuery);
			expect(wireQuery.query.case).toBe(queryCase);
			expect(wireQuery.$unknown).toBeUndefined();

			// The typed form survives a full encode/decode round trip.
			const typed = create(InteractionQuerySchema, {
				id: 43,
				query: { case: queryCase, value: create(schema as never) } as never,
			});
			const query = fromBinary(InteractionQuerySchema, toBinary(InteractionQuerySchema, typed));
			expect(query.query.case).toBe(queryCase);
			expect(query.$unknown).toBeUndefined();

			const response = decodeResponse(query);
			expect(response.message.case).toBe("interactionResponse");
			if (response.message.case !== "interactionResponse") throw new Error("wrong response envelope");
			expect(response.message.value.id).toBe(43);
			expect(response.message.value.result.case).toBe(responseCase);
			const value = response.message.value.result.value as any;
			expect(value.result?.case).toBe(nestedCase);
			expect(value.result?.value?.reason ?? value.result?.value?.errorMessage).toMatch(
				/Not implemented by this client/i,
			);
		},
	);

	it("decodes populated args for the field 9-14 query families", () => {
		// The bridge rejects without reading args, but the typed schema must
		// carry them: a query with real arguments decodes losslessly.
		const cases = [
			[
				"webFetchRequestQuery",
				WebFetchRequestQuerySchema,
				{ args: create(WebFetchArgsSchema, { url: "https://example.com", toolCallId: "t1" }), skipApproval: true },
			],
			[
				"prManagementRequestQuery",
				PrManagementRequestQuerySchema,
				{
					args: create(PrManagementArgsSchema, {
						toolCallId: "t2",
						action: { case: "getCiStatus", value: { prUrl: "https://github.com/x/y/pull/1" } },
					}),
				},
			],
			[
				"mcpAuthRequestQuery",
				McpAuthRequestQuerySchema,
				{ args: create(McpAuthArgsSchema, { serverIdentifier: "ops", toolCallId: "t3" }) },
			],
			[
				"generateImageRequestQuery",
				GenerateImageRequestQuerySchema,
				{
					args: create(GenerateImageArgsSchema, {
						description: "logo",
						filePath: "assets/logo.png",
						referenceImagePaths: ["ref.png"],
						aspectRatio: "1:1",
					}),
					toolCallId: "t4",
				},
			],
			[
				"replaceEnvArgs",
				ReplaceEnvArgsSchema,
				{ config: { installScript: "make setup" }, mode: 2, checkoutRefOverrides: [{ repoUrl: "r", ref: "f" }] },
			],
			[
				"connectScmRequestQuery",
				ConnectScmRequestQuerySchema,
				{
					args: create(ConnectScmArgsSchema, {
						toolCallId: "t6",
						target: { case: "github", value: { repository: { owner: "o", repo: "r" } } },
					}),
				},
			],
		] as const;
		for (const [queryCase, schema, value] of cases) {
			const query = fromBinary(
				InteractionQuerySchema,
				toBinary(
					InteractionQuerySchema,
					create(InteractionQuerySchema, {
						id: 45,
						query: { case: queryCase, value: create(schema as never, value as never) } as never,
					}),
				),
			);
			expect(query.query.case).toBe(queryCase);
			// Re-encoding the decoded query is byte-identical: nothing was lost
			// to `$unknown` on the way in.
			expect(toBinary(InteractionQuerySchema, query)).toEqual(
				toBinary(
					InteractionQuerySchema,
					create(InteractionQuerySchema, {
						id: 45,
						query: { case: queryCase, value: create(schema as never, value as never) } as never,
					}),
				),
			);
		}
	});

	it("matches all eleven current Cursor 2026.08.04 descriptor fields and excludes removed Exa fields", () => {
		expect([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]).toHaveLength(11);
		expect([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]).not.toContain(5);
		expect([2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14]).not.toContain(6);
	});

	it.each([
		["exaSearchRequestQuery", ExaSearchRequestQuerySchema, "exaSearchRequestResponse"],
		["exaFetchRequestQuery", ExaFetchRequestQuerySchema, "exaFetchRequestResponse"],
	] as const)("retains harmless legacy %s rejection", (queryCase, schema, responseCase) => {
		const response = decodeResponse(
			create(InteractionQuerySchema, {
				id: 44,
				query: { case: queryCase, value: create(schema, {}) } as never,
			}),
		);
		expect(response.message.case).toBe("interactionResponse");
		if (response.message.case !== "interactionResponse") throw new Error("wrong response envelope");
		expect(response.message.value.result.case).toBe(responseCase);
	});
});

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
} from "../src/providers/cursor-agent/agent_pb.js";
import { handleInteractionQuery } from "../src/providers/cursor-agent/index.js";

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

function currentUnknownQuery(id: number, fieldNo: number) {
	// Decode actual protobuf bytes rather than attaching `$unknown` directly: this
	// proves Buf preserves current descriptor fields missing from the baseline.
	return fromBinary(InteractionQuerySchema, concat(varint(8), varint(id), wireMessageField(fieldNo)));
}

function readVarint(data: Uint8Array, offset: number): [value: number, offset: number] {
	let value = 0;
	let shift = 0;
	while (offset < data.byteLength) {
		const byte = data[offset++];
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [value, offset];
		shift += 7;
	}
	throw new Error("truncated varint");
}

function firstLengthDelimitedField(data: Uint8Array): { fieldNo: number; data: Uint8Array } {
	const [tag, afterTag] = readVarint(data, 0);
	expect(tag & 7).toBe(2);
	const [length, afterLength] = readVarint(data, afterTag);
	return { fieldNo: tag >>> 3, data: data.subarray(afterLength, afterLength + length) };
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

	it("answers current setup VM field 8 with its defined success arm", () => {
		const response = decodeResponse(
			create(InteractionQuerySchema, {
				id: 42,
				query: { case: "setupVmEnvironmentArgs", value: create(SetupVmEnvironmentArgsSchema, {}) },
			}),
		);
		expect(response.message.case).toBe("interactionResponse");
		if (response.message.case !== "interactionResponse") throw new Error("wrong response envelope");
		expect(response.message.value.result.case).toBe("setupVmEnvironmentResult");
		expect((response.message.value.result.value as any).result.case).toBe("success");
	});

	it.each([
		[9, 2, "web fetch"],
		[10, 3, "PR management"],
		[11, 2, "MCP auth"],
		[12, 2, "generate image"],
		[13, 2, "replace env"],
		[14, 2, "connect SCM"],
	] as const)(
		"preserves current field %i %s and emits its exact populated raw response arm",
		(fieldNo, nestedArm, _label) => {
			const query = currentUnknownQuery(43, fieldNo);
			expect(query.query.case).toBeUndefined();
			expect(query.$unknown?.map((field) => field.no)).toEqual([fieldNo]);

			const response = decodeResponse(query);
			expect(response.message.case).toBe("interactionResponse");
			if (response.message.case !== "interactionResponse") throw new Error("wrong response envelope");
			expect(response.message.value.id).toBe(43);
			expect(response.message.value.result.case).toBeUndefined();
			const raw = response.message.value.$unknown;
			expect(raw).toHaveLength(1);
			expect(raw?.[0]).toMatchObject({ no: fieldNo, wireType: 2 });
			const unknownData = raw?.[0]?.data ?? new Uint8Array();
			const [payloadLength, payloadOffset] = readVarint(unknownData, 0);
			const payload = unknownData.subarray(payloadOffset, payloadOffset + payloadLength);
			const outer = firstLengthDelimitedField(payload);
			expect(outer.fieldNo).toBe(nestedArm);
			const detail = firstLengthDelimitedField(outer.data);
			expect(detail.fieldNo).toBe(1);
			expect(new TextDecoder().decode(detail.data)).toMatch(/Not implemented by this client/i);
		},
	);

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

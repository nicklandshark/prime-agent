import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AgentClientMessageSchema,
	ConversationStateStructureSchema,
	KvServerMessageSchema,
	SetBlobArgsSchema,
} from "../src/providers/cursor-not-cloud/agent_pb.js";
import { normalizeCursorOrigin } from "../src/providers/cursor-not-cloud/config.js";
import {
	CursorBlobCapacityError,
	CursorConversationStateStore,
	createCursorConversationStateKey,
	handleKvServerMessage,
} from "../src/providers/cursor-not-cloud/index.js";

describe("Cursor bounded conversation state", () => {
	it("evicts inactive conversations deterministically by LRU/count", () => {
		const store = new CursorConversationStateStore({ maxConversations: 2, conversationTtlMs: 1_000 });
		store.acquire("oldest", 0).release(0);
		store.acquire("newer", 1).release(1);
		store.acquire("third", 2).release(2);

		expect(store.stats().conversations).toBe(2);
		expect(store.disposeConversation("oldest")).toBe(false);
		expect(store.disposeConversation("newer")).toBe(true);
	});

	it("sweeps expired inactive state but never evicts an active lease", () => {
		const store = new CursorConversationStateStore({ conversationTtlMs: 10 });
		const active = store.acquire("active", 0);
		store.acquire("inactive", 0).release(0);
		expect(store.sweep(20)).toBe(1);
		expect(store.stats()).toMatchObject({ conversations: 1, activeConversations: 1 });
		active.release(20);
		expect(store.sweep(31)).toBe(1);
		expect(store.stats().conversations).toBe(0);
	});

	it("enforces per-conversation blob count and byte caps before allocation grows", () => {
		const store = new CursorConversationStateStore({
			maxBlobsPerConversation: 1,
			maxBlobBytesPerConversation: 4,
			maxBlobBytesTotal: 8,
		});
		const lease = store.acquire("one", 0);
		lease.blobStore.set("a", new Uint8Array(4));
		expect(() => lease.blobStore.set("b", new Uint8Array(1))).toThrow(CursorBlobCapacityError);
		expect(() => lease.blobStore.set("a", new Uint8Array(5))).toThrow(CursorBlobCapacityError);
		expect(store.stats().blobBytes).toBe(4);
		lease.release(0);
	});

	it("evicts inactive blob owners for the global byte cap", () => {
		const store = new CursorConversationStateStore({
			maxBlobBytesPerConversation: 8,
			maxBlobBytesTotal: 8,
		});
		const old = store.acquire("old", 0);
		old.blobStore.set("a", new Uint8Array(6));
		old.release(0);
		const current = store.acquire("current", 1);
		current.blobStore.set("b", new Uint8Array(6));

		expect(store.stats().blobBytes).toBe(6);
		expect(store.disposeConversation("old")).toBe(false);
		current.release(1);
	});

	it("rejects active-conversation blob overflow rather than exceeding the global cap", () => {
		const store = new CursorConversationStateStore({
			maxBlobBytesPerConversation: 8,
			maxBlobBytesTotal: 8,
		});
		const first = store.acquire("first", 0);
		first.blobStore.set("a", new Uint8Array(6));
		const second = store.acquire("second", 1);
		expect(() => second.blobStore.set("b", new Uint8Array(6))).toThrow(/full with active conversations/i);
		expect(store.stats().blobBytes).toBe(6);
		first.release(1);
		second.release(1);
	});

	it("bounds serialized checkpoint bytes", () => {
		const store = new CursorConversationStateStore({
			maxStateBytesPerConversation: 16,
			maxStateBytesTotal: 32,
		});
		const lease = store.acquire("checkpoint", 0);
		const oversized = create(ConversationStateStructureSchema, {
			rootPromptMessagesJson: [new TextEncoder().encode("x".repeat(32))],
		});
		expect(() => lease.setConversationState(oversized, 0)).toThrow(/checkpoint exceeds/i);
		expect(store.stats().stateBytes).toBe(0);
		lease.release(0);
	});

	it("bounds warning keys with LRU/count and TTL cleanup", () => {
		const store = new CursorConversationStateStore({ maxWarningKeys: 2, warningTtlMs: 5 });
		store.markWarning("a", 0);
		store.markWarning("b", 1);
		store.markWarning("c", 2);
		expect(store.stats().warningKeys).toBe(2);
		expect(store.hasWarning("a", 2)).toBe(false);
		expect(store.hasWarning("b", 2)).toBe(true);
		store.sweep(8);
		expect(store.stats().warningKeys).toBe(0);
	});

	it("settles an overflowing active KV set with a typed error response", () => {
		const store = new CursorConversationStateStore({ maxBlobBytesPerConversation: 4, maxBlobBytesTotal: 4 });
		const lease = store.acquire("active-kv", 0);
		let written: Buffer | undefined;
		const request = {
			write(chunk: Buffer) {
				written = chunk;
				return true;
			},
		} as unknown as Parameters<typeof handleKvServerMessage>[2];
		const message = create(KvServerMessageSchema, {
			id: 9,
			message: {
				case: "setBlobArgs",
				value: create(SetBlobArgsSchema, { blobId: new Uint8Array([1]), blobData: new Uint8Array(5) }),
			},
		});

		handleKvServerMessage(message, lease.blobStore, request);
		if (!written) throw new Error("KV handler did not settle");
		const length = written.readUInt32BE(1);
		const response = fromBinary(AgentClientMessageSchema, written.subarray(5, 5 + length));
		expect(response.message.case).toBe("kvClientMessage");
		if (response.message.case !== "kvClientMessage") throw new Error("wrong KV envelope");
		expect(response.message.value.message.case).toBe("setBlobResult");
		if (response.message.value.message.case !== "setBlobResult") throw new Error("wrong KV result");
		expect(response.message.value.message.value.error?.message).toMatch(/blob byte limit exceeded/i);
		expect(store.stats().blobBytes).toBe(0);
		lease.release(0);
	});

	it("isolates state by credential/base URL and rejects concurrent turns on one key", () => {
		const keyA = createCursorConversationStateKey("credential-a", "https://api2.cursor.sh/", "session-1");
		const keyB = createCursorConversationStateKey("credential-b", "https://api2.cursor.sh", "session-1");
		expect(keyA).not.toBe(keyB);
		expect(keyA).not.toContain("credential-a");
		const store = new CursorConversationStateStore();
		const lease = store.acquire(keyA);
		expect(() => store.acquire(keyA)).toThrow(/Concurrent Cursor turns/i);
		const isolated = store.acquire(keyB);
		isolated.release();
		lease.release();
	});

	it("canonicalizes trusted origins and rejects ambiguous or untrusted base URLs", () => {
		expect(normalizeCursorOrigin("https://API2.Cursor.SH:443/")).toBe("https://api2.cursor.sh");
		expect(normalizeCursorOrigin("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
		for (const bad of [
			"http://api2.cursor.sh",
			"https://user:pass@api2.cursor.sh",
			"https://api2.cursor.sh/path",
			"https://api2.cursor.sh/?query=1",
			"https://api2.cursor.sh/#fragment",
		])
			expect(() => normalizeCursorOrigin(bad)).toThrow();
	});

	it("length-prefixes state tuple components so colon-shaped namespaces cannot collide", () => {
		const left = createCursorConversationStateKey("credential", "https://api2.cursor.sh", "a:b");
		const right = createCursorConversationStateKey("credential", "https://api2.cursor.sh", "b:a");
		const canonical = createCursorConversationStateKey("credential", "https://API2.Cursor.SH:443/", "a:b");
		expect(left).not.toBe(right);
		expect(left).toBe(canonical);
	});
});

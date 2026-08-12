import { describe, expect, it, vi } from "vitest";
import { CursorIdentityError, fetchCursorAccountIdentity } from "../src/providers/cursor-not-cloud/identity.js";

const token = "header.payload.signature";

describe("Cursor GetMe identity", () => {
	it("returns only whitelisted identity fields and sends JSON Connect bearer auth", async () => {
		const fetchMock = vi.fn(async (_url: URL | string | Request, init?: RequestInit) => {
			expect(init?.headers).toMatchObject({
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"connect-protocol-version": "1",
			});
			return new Response(
				JSON.stringify({
					email: "fixture@example.test",
					authId: "auth-fixture",
					userId: "user-fixture",
					profilePictureUrl: "secret",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		await expect(fetchCursorAccountIdentity(token, { fetch: fetchMock as typeof fetch })).resolves.toEqual({
			email: "fixture@example.test",
			authId: "auth-fixture",
			userId: "user-fixture",
		});
	});

	it("accepts a valid unidentified response for safe fallbacks", async () => {
		const fetchMock = vi.fn(
			async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
		);
		await expect(fetchCursorAccountIdentity(token, { fetch: fetchMock as typeof fetch })).resolves.toEqual({});
	});

	it.each([
		["malformed", async () => new Response("not-json", { status: 200 }), "decode", undefined],
		["unauthorized", async () => new Response("private body", { status: 401 }), "http", 401],
		["forbidden", async () => new Response("private body", { status: 403 }), "http", 403],
		[
			"oversized",
			async () =>
				new Response("x".repeat(64 * 1024 + 1), { status: 200, headers: { "content-type": "application/json" } }),
			"oversized",
			undefined,
		],
	] as const)("sanitizes %s failures", async (_name, mock, kind, status) => {
		let error: unknown;
		try {
			await fetchCursorAccountIdentity(token, { fetch: mock as typeof fetch });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CursorIdentityError);
		expect(error).toMatchObject({ kind, ...(status ? { status } : {}) });
		expect(String(error)).not.toContain(token);
		expect(String(error)).not.toContain("private body");
	});

	it("bounds timeout and propagates caller abort without token disclosure", async () => {
		const hanging = vi.fn(
			async (_url: URL | string | Request, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
				),
		);
		await expect(
			fetchCursorAccountIdentity(token, { fetch: hanging as typeof fetch, timeoutMs: 10 }),
		).rejects.toMatchObject({
			kind: "timeout",
		});
		const controller = new AbortController();
		const pending = fetchCursorAccountIdentity(token, { fetch: hanging as typeof fetch, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "abort" });
	});

	it("cancels a chunked infinite body as soon as the 64 KiB bound is crossed", async () => {
		let bytesRead = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = new Uint8Array(1024);
				bytesRead += chunk.byteLength;
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetchMock = vi.fn(
			async () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await expect(fetchCursorAccountIdentity(token, { fetch: fetchMock as typeof fetch })).rejects.toMatchObject({
			kind: "oversized",
		});
		expect(cancelled).toBe(true);
		expect(bytesRead).toBeLessThanOrEqual(66 * 1024);
	});
});

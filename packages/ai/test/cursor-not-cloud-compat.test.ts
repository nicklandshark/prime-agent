import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectProxiedSocket } from "../src/providers/cursor-not-cloud/compat.js";

let server: net.Server | undefined;
async function start(handler: (socket: net.Socket) => void): Promise<string> {
	server = net.createServer(handler);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("proxy fixture failed");
	return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
	if (!server) return;
	const current = server;
	server = undefined;
	await new Promise<void>((resolve) => current.close(() => resolve()));
});

describe("Cursor proxy CONNECT parser", () => {
	it("caps an unterminated response header at 64 KiB", async () => {
		const proxy = await start((socket) => socket.on("data", () => socket.write("x".repeat(65 * 1024))));
		await expect(connectProxiedSocket(proxy, "https://api2.cursor.sh", { timeoutMs: 1_000 })).rejects.toThrow(
			/exceeded 64 KiB/i,
		);
	});

	it("catches malformed percent-encoded proxy credentials as a typed rejection", async () => {
		const proxy = await start((socket) => socket.on("data", () => {}));
		const url = new URL(proxy);
		url.username = "%GG";
		await expect(
			connectProxiedSocket(url.toString(), "https://api2.cursor.sh", { timeoutMs: 1_000 }),
		).rejects.toThrow(/URI malformed/i);
	});
});

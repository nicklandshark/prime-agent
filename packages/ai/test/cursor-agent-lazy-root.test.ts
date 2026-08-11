import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("pi-ai root lazy loading", () => {
	it("does not load Cursor's HTTP/2 runtime or generated descriptor on a cold root import", () => {
		const rootEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const script = `
			await import(${JSON.stringify(rootEntry)});
			const loaded = process.moduleLoadList.filter((entry) =>
				entry.includes("http2") || entry.includes("agent_pb")
			);
			process.stdout.write(JSON.stringify(loaded));
		`;
		const stdout = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
		});
		expect(JSON.parse(stdout)).toEqual([]);
	});
});

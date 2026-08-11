import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CursorCloudAgentSummary,
	type CursorCloudTunnelRegistryEntry,
	deriveCursorCloudActiveRuns,
	deriveCursorCloudNamedEnvironments,
	formatCursorCloudSshTarget,
	getCachedCursorCloudEnvironments,
	joinCursorCloudEnvironments,
	listCursorCloudAgents,
	listCursorCloudEnvironments,
	readCursorCloudRegistry,
	resolveCursorCloudApiKey,
} from "../src/core/cursor-cloud-environments.js";

function makeRegistryEntry(overrides: Partial<CursorCloudTunnelRegistryEntry> = {}): CursorCloudTunnelRegistryEntry {
	return {
		agent_id: "bc-aaa",
		repo: "https://github.com/acme/ea-tycoon",
		ssh_host: "1.2.3.4.bore.pub",
		ssh_port: 2200,
		ssh_user: "ubuntu",
		via: "bore.pub",
		created_at: "2026-08-01T00:00:00.000Z",
		last_verified_at: "2026-08-09T00:00:00.000Z",
		...overrides,
	};
}

function makeAgent(overrides: Partial<CursorCloudAgentSummary> = {}): CursorCloudAgentSummary {
	return {
		id: "bc-aaa",
		name: "ea-tycoon",
		status: "ACTIVE",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-09T00:00:00.000Z",
		latestRunId: "run-1",
		...overrides,
	};
}

function makeResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as unknown as Response;
}

describe("cursor-cloud-environments core", () => {
	let agentDir: string;
	let savedEnvKey: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "cursor-cloud-test-"));
		savedEnvKey = process.env.CURSOR_API_KEY;
		delete process.env.CURSOR_API_KEY;
	});

	afterEach(() => {
		if (savedEnvKey === undefined) {
			delete process.env.CURSOR_API_KEY;
		} else {
			process.env.CURSOR_API_KEY = savedEnvKey;
		}
		rmSync(agentDir, { recursive: true, force: true });
	});

	function writeRegistry(tunnels: Record<string, unknown>): void {
		writeFileSync(join(agentDir, "cursor-cloud.json"), JSON.stringify({ version: 1, tunnels }), { mode: 0o600 });
	}

	describe("readCursorCloudRegistry", () => {
		it("returns an empty map when the registry file is missing", () => {
			expect(readCursorCloudRegistry(agentDir)).toEqual({});
		});

		it("returns an empty map for malformed JSON", () => {
			writeFileSync(join(agentDir, "cursor-cloud.json"), "not json {");
			expect(readCursorCloudRegistry(agentDir)).toEqual({});
		});

		it("returns an empty map when tunnels is not an object", () => {
			writeFileSync(join(agentDir, "cursor-cloud.json"), JSON.stringify({ version: 1, tunnels: [] }));
			expect(readCursorCloudRegistry(agentDir)).toEqual({});
		});

		it("parses valid entries and skips entries without an agent_id", () => {
			writeRegistry({
				"ea-tycoon": makeRegistryEntry(),
				broken: { repo: "https://github.com/acme/broken" },
			});
			const registry = readCursorCloudRegistry(agentDir);
			expect(Object.keys(registry)).toEqual(["ea-tycoon"]);
			expect(registry["ea-tycoon"]?.agent_id).toBe("bc-aaa");
			expect(registry["ea-tycoon"]?.via).toBe("bore.pub");
		});
	});

	describe("resolveCursorCloudApiKey", () => {
		it("prefers the CURSOR_API_KEY env var", () => {
			process.env.CURSOR_API_KEY = "env-key";
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cursor: { type: "api_key", key: "file-key" } }));
			expect(resolveCursorCloudApiKey(agentDir)).toBe("env-key");
		});

		it("falls back to the auth.json cursor api_key entry", () => {
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cursor: { type: "api_key", key: "file-key" } }));
			expect(resolveCursorCloudApiKey(agentDir)).toBe("file-key");
		});

		it("resolves env-var references stored as the key", () => {
			process.env.MY_CURSOR_KEY = "referenced-key";
			try {
				writeFileSync(
					join(agentDir, "auth.json"),
					JSON.stringify({ cursor: { type: "api_key", key: "MY_CURSOR_KEY" } }),
				);
				expect(resolveCursorCloudApiKey(agentDir)).toBe("referenced-key");
			} finally {
				delete process.env.MY_CURSOR_KEY;
			}
		});

		it("returns undefined when nothing is configured", () => {
			expect(resolveCursorCloudApiKey(agentDir)).toBeUndefined();
		});

		it("ignores non-api_key credentials", () => {
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ cursor: { type: "oauth", access: "tok" } }));
			expect(resolveCursorCloudApiKey(agentDir)).toBeUndefined();
		});
	});

	describe("formatCursorCloudSshTarget", () => {
		it("builds host:port@user", () => {
			expect(formatCursorCloudSshTarget(makeRegistryEntry())).toBe("1.2.3.4.bore.pub:2200@ubuntu");
		});

		it("defaults the port to 22", () => {
			expect(formatCursorCloudSshTarget(makeRegistryEntry({ ssh_port: undefined }))).toBe(
				"1.2.3.4.bore.pub:22@ubuntu",
			);
		});

		it("falls back to the tailscale ip", () => {
			expect(formatCursorCloudSshTarget(makeRegistryEntry({ ssh_host: undefined, tailscale_ip: "100.1.2.3" }))).toBe(
				"100.1.2.3:2200@ubuntu",
			);
		});

		it("omits the user when absent and returns undefined without a host", () => {
			expect(formatCursorCloudSshTarget(makeRegistryEntry({ ssh_user: undefined }))).toBe("1.2.3.4.bore.pub:2200");
			expect(formatCursorCloudSshTarget(makeRegistryEntry({ ssh_host: undefined }))).toBeUndefined();
		});
	});

	describe("joinCursorCloudEnvironments", () => {
		const registry = { "ea-tycoon": makeRegistryEntry() };

		it("marks registry entries ACTIVE when the server returns them", () => {
			const views = joinCursorCloudEnvironments(registry, [makeAgent()]);
			expect(views).toHaveLength(1);
			expect(views[0]).toMatchObject({
				name: "ea-tycoon",
				agentId: "bc-aaa",
				serverStatus: "ACTIVE",
				latestRunId: "run-1",
				sshTarget: "1.2.3.4.bore.pub:2200@ubuntu",
				via: "bore.pub",
			});
		});

		it("marks registry entries missing when the server no longer returns them", () => {
			const views = joinCursorCloudEnvironments(registry, []);
			expect(views[0]?.serverStatus).toBe("missing");
		});

		it("marks entries unknown when the server was not queried", () => {
			const views = joinCursorCloudEnvironments(registry, undefined);
			expect(views[0]?.serverStatus).toBe("unknown");
			expect(views[0]?.lastVerifiedAt).toBe("2026-08-09T00:00:00.000Z");
		});

		it("lists server agents without a registry entry as unregistered", () => {
			const views = joinCursorCloudEnvironments(registry, [makeAgent(), makeAgent({ id: "bc-bbb", name: "other" })]);
			expect(views).toHaveLength(2);
			expect(views[1]).toMatchObject({ name: "other", agentId: "bc-bbb", serverStatus: "unregistered" });
		});

		it("omits unregistered agents when includeUnregistered is false", () => {
			const views = joinCursorCloudEnvironments(registry, [makeAgent({ id: "bc-bbb" })], {
				includeUnregistered: false,
			});
			expect(views).toHaveLength(1);
			expect(views[0]?.serverStatus).toBe("missing");
		});

		it("sorts registry entries by name", () => {
			const views = joinCursorCloudEnvironments(
				{
					zeta: makeRegistryEntry({ agent_id: "bc-z" }),
					alpha: makeRegistryEntry({ agent_id: "bc-a" }),
				},
				undefined,
			);
			expect(views.map((view) => view.name)).toEqual(["alpha", "zeta"]);
		});
	});

	describe("listCursorCloudAgents", () => {
		it("sends Basic auth and includeArchived, and pages via nextCursor", async () => {
			const calls: { url: string; authorization?: string }[] = [];
			const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				calls.push({ url: String(url), authorization: headers.authorization });
				if (calls.length === 1) {
					return makeResponse({ items: [makeAgent()], nextCursor: "page-2" });
				}
				return makeResponse({ items: [makeAgent({ id: "bc-bbb" })], nextCursor: null });
			}) as unknown as typeof fetch;

			const agents = await listCursorCloudAgents({ apiKey: "secret-key", fetchImpl });

			expect(agents.map((agent) => agent.id)).toEqual(["bc-aaa", "bc-bbb"]);
			expect(calls).toHaveLength(2);
			expect(calls[0]?.url).toContain("https://api.cursor.com/v1/agents?");
			expect(calls[0]?.url).toContain("includeArchived=true");
			expect(calls[1]?.url).toContain("cursor=page-2");
			const expectedAuth = `Basic ${Buffer.from("secret-key:").toString("base64")}`;
			expect(calls[0]?.authorization).toBe(expectedAuth);
		});

		it("throws on a non-ok response without leaking the key", async () => {
			const fetchImpl = vi.fn(async () =>
				makeResponse({ error: { message: "nope" } }, 401),
			) as unknown as typeof fetch;
			await expect(listCursorCloudAgents({ apiKey: "secret-key", fetchImpl })).rejects.toThrow("HTTP 401");
			await expect(listCursorCloudAgents({ apiKey: "secret-key", fetchImpl })).rejects.not.toThrow("secret-key");
		});
	});

	describe("deriveCursorCloudNamedEnvironments", () => {
		it("collects distinct env.name values where env.type is cloud", () => {
			const views = deriveCursorCloudNamedEnvironments([
				makeAgent({ env: { type: "cloud", name: "sedona-agent" } }),
				makeAgent({ id: "bc-bbb", env: { type: "cloud", name: "x-plugin" } }),
				makeAgent({ id: "bc-ccc", env: { type: "cloud", name: "sedona-agent" } }),
			]);

			expect(views.map((view) => view.name).sort()).toEqual(["sedona-agent", "x-plugin"]);
			const sedona = views.find((view) => view.name === "sedona-agent");
			expect(sedona?.agentCount).toBe(2);
		});

		it("ignores agents without a cloud env name", () => {
			const views = deriveCursorCloudNamedEnvironments([
				makeAgent({ env: undefined }),
				makeAgent({ id: "bc-bbb", env: { type: "local", name: "laptop" } }),
				makeAgent({ id: "bc-ccc", env: { type: "cloud" } }),
				makeAgent({ id: "bc-ddd", env: { type: "cloud", name: "   " } }),
				makeAgent({ id: "bc-eee", env: "cloud" }),
				makeAgent({ id: "bc-fff", env: null }),
			]);

			expect(views).toEqual([]);
		});

		it("tracks the most recent updatedAt per environment and sorts by latest activity", () => {
			const views = deriveCursorCloudNamedEnvironments([
				makeAgent({
					env: { type: "cloud", name: "old-env" },
					updatedAt: "2026-08-01T00:00:00.000Z",
				}),
				makeAgent({
					id: "bc-bbb",
					env: { type: "cloud", name: "fresh-env" },
					updatedAt: "2026-08-10T00:00:00.000Z",
				}),
				makeAgent({
					id: "bc-ccc",
					env: { type: "cloud", name: "old-env" },
					updatedAt: "2026-08-05T00:00:00.000Z",
				}),
			]);

			expect(views.map((view) => view.name)).toEqual(["fresh-env", "old-env"]);
			expect(views[1]?.lastActivityAt).toBe("2026-08-05T00:00:00.000Z");
		});

		it("returns an empty list when the server was not queried", () => {
			expect(deriveCursorCloudNamedEnvironments(undefined)).toEqual([]);
			expect(deriveCursorCloudNamedEnvironments([])).toEqual([]);
		});
	});

	describe("deriveCursorCloudActiveRuns", () => {
		it("lists ACTIVE agents with a latestRunId, most recently updated first", () => {
			const runs = deriveCursorCloudActiveRuns([
				makeAgent({
					updatedAt: "2026-08-09T00:00:00.000Z",
					env: { type: "cloud", name: "sedona-agent" },
				}),
				makeAgent({ id: "bc-bbb", name: "other", updatedAt: "2026-08-10T00:00:00.000Z", latestRunId: "run-2" }),
				makeAgent({ id: "bc-ccc", status: "ARCHIVED", latestRunId: "run-3" }),
				makeAgent({ id: "bc-ddd", status: "ACTIVE", latestRunId: undefined }),
			]);

			expect(runs.map((run) => run.agentId)).toEqual(["bc-bbb", "bc-aaa"]);
			expect(runs[1]).toMatchObject({
				agentName: "ea-tycoon",
				environmentName: "sedona-agent",
				latestRunId: "run-1",
			});
		});

		it("returns an empty list when the server was not queried", () => {
			expect(deriveCursorCloudActiveRuns(undefined)).toEqual([]);
		});
	});

	describe("listCursorCloudEnvironments", () => {
		it("joins registry entries with live server data and derives named environments and active runs", async () => {
			writeRegistry({ "ea-tycoon": makeRegistryEntry() });
			const fetchImpl = vi.fn(async () =>
				makeResponse({
					items: [
						makeAgent({ env: { type: "cloud", name: "sedona-agent" } }),
						makeAgent({ id: "bc-bbb", name: "other", env: { type: "cloud", name: "sedona-agent" } }),
					],
					nextCursor: null,
				}),
			) as unknown as typeof fetch;

			const result = await listCursorCloudEnvironments({ agentDir, apiKey: "key", fetchImpl });

			expect(result.serverError).toBeUndefined();
			expect(result.builderEnvironments[0]?.serverStatus).toBe("ACTIVE");
			expect(result.namedEnvironments).toHaveLength(1);
			expect(result.namedEnvironments[0]).toMatchObject({ name: "sedona-agent", agentCount: 2 });
			expect(result.activeRuns?.map((run) => run.agentId).sort()).toEqual(["bc-aaa", "bc-bbb"]);
		});

		it("falls back to registry-only views with a note on network failure", async () => {
			writeRegistry({ "ea-tycoon": makeRegistryEntry() });
			const fetchImpl = vi.fn(async () => {
				throw new Error("socket hangup");
			}) as unknown as typeof fetch;

			const result = await listCursorCloudEnvironments({ agentDir, apiKey: "key", fetchImpl });

			expect(result.serverError).toContain("server unreachable");
			expect(result.serverError).toContain("socket hangup");
			expect(result.namedEnvironments).toEqual([]);
			expect(result.activeRuns).toBeUndefined();
			expect(result.builderEnvironments[0]?.serverStatus).toBe("unknown");
		});

		it("returns registry-only views with a note when no API key is configured", async () => {
			writeRegistry({ "ea-tycoon": makeRegistryEntry() });
			const fetchImpl = vi.fn() as unknown as typeof fetch;

			const result = await listCursorCloudEnvironments({ agentDir, fetchImpl });

			expect(result.serverError).toContain("no Cursor API key");
			expect(result.namedEnvironments).toEqual([]);
			expect(result.activeRuns).toBeUndefined();
			expect(result.builderEnvironments[0]?.serverStatus).toBe("unknown");
			expect(fetchImpl).not.toHaveBeenCalled();
		});

		it("rethrows abort errors instead of falling back", async () => {
			writeRegistry({ "ea-tycoon": makeRegistryEntry() });
			const abort = new AbortController();
			abort.abort();
			const fetchImpl = vi.fn(async () => {
				throw new Error("The operation was aborted");
			}) as unknown as typeof fetch;

			await expect(
				listCursorCloudEnvironments({ agentDir, apiKey: "key", fetchImpl, signal: abort.signal }),
			).rejects.toThrow("aborted");
		});
	});

	describe("getCachedCursorCloudEnvironments", () => {
		it("returns registry-only builder views without any network", () => {
			writeRegistry({ "ea-tycoon": makeRegistryEntry() });
			const view = getCachedCursorCloudEnvironments(agentDir);
			expect(view.namedEnvironments).toEqual([]);
			expect(view.activeRuns).toBeUndefined();
			expect(view.builderEnvironments).toHaveLength(1);
			expect(view.builderEnvironments[0]?.serverStatus).toBe("unknown");
		});

		it("returns empty sections when no registry exists", () => {
			expect(getCachedCursorCloudEnvironments(agentDir)).toEqual({
				namedEnvironments: [],
				builderEnvironments: [],
			});
		});
	});
});

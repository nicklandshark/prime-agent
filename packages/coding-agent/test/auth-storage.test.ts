import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearConfigValueCache } from "../src/core/resolve-config-value.js";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("ambient environment credentials count as available auth", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "pi-test-profile";

			try {
				authStorage = AuthStorage.inMemory();

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
				expect(authStorage.getAuthStatus("amazon-bedrock")).toEqual({
					configured: false,
					source: "environment",
					label: "ambient credentials",
				});
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("changed ambient environment credential no longer matches stale auth marker", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "stale-profile";

			try {
				authStorage = AuthStorage.inMemory();
				expect(authStorage.markAuthStale("amazon-bedrock")).toBe(true);
				expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBeUndefined();

				process.env.AWS_PROFILE = "fresh-profile";

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				await expect(authStorage.getApiKey("amazon-bedrock")).resolves.toBe("<authenticated>");
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("prime inference falls back to Prime CLI config when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime cli config changes are picked up without reload", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("changed-prime-key");
		});

		test("prime inference marks current Prime CLI auth stale", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.markAuthStale("prime-inference")).toBe(true);

			expect(authStorage.hasAuth("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
		});

		test("changed Prime CLI key no longer matches stale auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("changed-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("new-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("stored credential updates do not revive stale runtime auth", async () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);

			authStorage.set("anthropic", { type: "api_key", key: "stored-key" });

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stored-key");

			authStorage.remove("anthropic");

			expect(authStorage.getAuthStatus("anthropic")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();
		});

		test("changed command-backed stored key no longer matches stale auth marker", async () => {
			const tokenFile = join(tempDir, "command-token");
			writeFileSync(tokenFile, "stale-key");
			const tokenPath = toShPath(tokenFile);
			writeAuthJson({
				anthropic: { type: "api_key", key: `!sh -c 'cat "${tokenPath}"'` },
			});

			authStorage = AuthStorage.create(authJsonPath);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("stale-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBeUndefined();

			writeFileSync(tokenFile, "fresh-key");

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-key");
			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		test("prime inference uses Prime CLI auth over stored auth", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("prime-cli-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime inference uses environment auth over Prime CLI and stored auth", async () => {
			const originalPrimeApiKey = process.env.PRIME_API_KEY;
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_API_KEY = "env-prime-key";
			delete process.env.PRIME_TEAM_ID;
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(
					primeConfigPath,
					JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team", team_name: "CLI Research" }),
				);
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: { teamId: "stored-team", name: "Stored Research" },
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("env-prime-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({
					configured: false,
					source: "environment",
					label: "PRIME_API_KEY",
				});
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeApiKey === undefined) {
					delete process.env.PRIME_API_KEY;
				} else {
					process.env.PRIME_API_KEY = originalPrimeApiKey;
				}
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference provider headers use selected Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "cli-team",
					team_name: "CLI Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
			expect(authStorage.getPrimeInferenceTeamSelection()).toEqual({
				teamId: "cli-team",
				name: "CLI Research",
				role: "admin",
			});
		});

		test("prime inference legacy personal selection suppresses Prime CLI team fallback without Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference legacy personal selection suppresses Prime CLI team with Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference environment team overrides legacy personal selection", () => {
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_TEAM_ID = "env-team";
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: null,
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "env-team" });
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference missing Agent team selection falls back to Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
		});

		test("prime inference provider header changes are picked up without reload", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-1" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-2" }));
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-2" });
		});

		test("setPrimeInferenceApiKey creates Prime CLI config", async () => {
			const primeConfigPath = join(tempDir, "prime", "config.json");
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(statSync(primeConfigPath).mode & 0o777).toBe(0o600);
			expect(authStorage.has("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBe("new-prime-key");
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI team selection", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "old-prime-key",
					team_id: "old-team",
					team_name: "Old Team",
					team_role: "admin",
				}),
			);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(config.team_role).toBeUndefined();
		});

		test("setPrimeInferenceApiKey preserves Prime CLI team selection for the same key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey migrates legacy team selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("setPrimeInferenceApiKey migrates legacy personal selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
		});

		test("setPrimeInferenceApiKey removes legacy Prime Agent credential after Prime CLI save", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const agentAuth = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(agentAuth["prime-inference"]).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey throws when Prime CLI config cannot be written", () => {
			const primeConfigPath = join(tempDir, "prime-config-dir");
			mkdirSync(primeConfigPath);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(() => authStorage.setPrimeInferenceApiKey("new-prime-key")).toThrow();
			expect(authStorage.drainErrors()).toHaveLength(1);
		});

		test("setPrimeInferenceApiKey preserves team selection when Prime CLI config is disabled", () => {
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.get("prime-inference")).toEqual({
				type: "api_key",
				key: "new-prime-key",
				primeTeam: { teamId: "team-1", name: "Research" },
			});
		});

		test("logout clears Prime CLI credentials when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.logout("prime-inference");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBeUndefined();
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
		});

		test("setPrimeInferenceTeamSelection writes Prime CLI config", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceTeamSelection({ teamId: "team-1", name: "Research", role: "admin" });

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				// Create multiple AuthStorage instances
				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				// Clear cache and call again
				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});

	describe("openai-codex account pool", () => {
		const future = () => Date.now() + 3_600_000;
		const past = () => Date.now() - 60_000;

		function codexJwt(accountId: string, email?: string): string {
			const payload = Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: accountId },
					...(email ? { email } : {}),
				}),
				"utf8",
			).toString("base64");
			return `aaa.${payload}.bbb`;
		}

		function accountFixture(
			accountId: string,
			overrides: { refresh?: string; expires?: number; email?: string; label?: string } = {},
		) {
			return {
				access: codexJwt(accountId, overrides.email),
				refresh: overrides.refresh ?? `refresh-${accountId}`,
				expires: overrides.expires ?? future(),
				accountId,
				...(overrides.email ? { email: overrides.email } : {}),
				...(overrides.label ? { label: overrides.label } : {}),
			};
		}

		function pooledCredential(accounts: Record<string, ReturnType<typeof accountFixture>>, activeAccountId: string) {
			const active = accounts[activeAccountId]!;
			return {
				type: "oauth" as const,
				access: active.access,
				refresh: active.refresh,
				expires: active.expires,
				accountId: active.accountId,
				...(active.email ? { email: active.email } : {}),
				...(active.label ? { label: active.label } : {}),
				accountPool: {
					schemaVersion: 1 as const,
					activeAccountId,
					accounts,
				},
			};
		}

		function readOnDisk(): Record<string, any> {
			return JSON.parse(readFileSync(authJsonPath, "utf-8"));
		}

		function stubTokenEndpoint(
			handler: (refreshToken: string) => { access: string; refresh: string; idToken?: string },
		) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
					const params = init?.body as URLSearchParams;
					const result = handler(params.get("refresh_token") ?? "");
					return new Response(
						JSON.stringify({
							access_token: result.access,
							refresh_token: result.refresh,
							expires_in: 3600,
							...(result.idToken ? { id_token: result.idToken } : {}),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}),
			);
		}

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		test("migrates a legacy single credential into a one-account pool and persists it", () => {
			const legacy = accountFixture("acc_a", { email: "a@example.com" });
			writeAuthJson({ "openai-codex": { type: "oauth", ...legacy } });

			authStorage = AuthStorage.create(authJsonPath);

			const onDisk = readOnDisk();
			expect(onDisk["openai-codex"].accountPool).toMatchObject({
				schemaVersion: 1,
				activeAccountId: "acc_a",
			});
			expect(onDisk["openai-codex"].accountPool.accounts.acc_a).toMatchObject({
				accountId: "acc_a",
				refresh: "refresh-acc_a",
				email: "a@example.com",
			});
			// Top-level fields mirror the active account
			expect(onDisk["openai-codex"].access).toBe(legacy.access);
			expect(onDisk["openai-codex"].accountId).toBe("acc_a");
			// Existing consumers still see a plain oauth credential
			expect(authStorage.get("openai-codex")?.type).toBe("oauth");
			expect(authStorage.listOpenAICodexAccounts().map((a) => a.accountId)).toEqual(["acc_a"]);
		});

		test("legacy credential without a derivable accountId gets a stable hash key", () => {
			writeAuthJson({
				"openai-codex": { type: "oauth", access: "opaque-access", refresh: "opaque-refresh", expires: future() },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const first = authStorage.listOpenAICodexAccounts();
			expect(first).toHaveLength(1);
			expect(first[0]!.accountId).toMatch(/^legacy-[0-9a-f]{16}$/);

			// Stable across reloads
			authStorage.reload();
			expect(authStorage.listOpenAICodexAccounts()[0]!.accountId).toBe(first[0]!.accountId);
		});

		test("login upserts into the pool instead of replacing it", async () => {
			writeAuthJson({ "openai-codex": { type: "oauth", ...accountFixture("acc_a", { email: "a@example.com" }) } });
			authStorage = AuthStorage.create(authJsonPath);

			let loginCount = 0;
			registerOAuthProvider({
				id: "openai-codex",
				name: "Test Codex",
				async login() {
					loginCount++;
					return accountFixture(`acc_${String.fromCharCode(98 + loginCount - 1)}`); // acc_b, acc_c, ...
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});
			try {
				await authStorage.login("openai-codex", {
					onAuth: () => {},
					onPrompt: async () => "",
				});
				await authStorage.login("openai-codex", {
					onAuth: () => {},
					onPrompt: async () => "",
				});
			} finally {
				unregisterOAuthProvider("openai-codex");
			}

			const accounts = authStorage.listOpenAICodexAccounts().map((a) => a.accountId);
			expect(accounts).toEqual(["acc_a", "acc_b", "acc_c"]);
			expect(authStorage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_c");
			// Mirror follows the active account
			const cred = authStorage.get("openai-codex");
			if (cred?.type !== "oauth") {
				throw new Error("expected oauth credential");
			}
			expect(cred.accountId).toBe("acc_c");
		});

		test("set() with an unpooled credential upserts instead of dropping pooled accounts", () => {
			writeAuthJson({
				"openai-codex": pooledCredential({ acc_a: accountFixture("acc_a") }, "acc_a"),
			});
			authStorage = AuthStorage.create(authJsonPath);

			authStorage.set("openai-codex", { type: "oauth", ...accountFixture("acc_b") });

			expect(authStorage.listOpenAICodexAccounts().map((a) => a.accountId)).toEqual(["acc_a", "acc_b"]);
			expect(authStorage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");
		});

		test("refresh only updates the expired active account and preserves the others", async () => {
			writeAuthJson({
				"openai-codex": pooledCredential(
					{
						acc_a: accountFixture("acc_a", { expires: past(), email: "a@example.com", label: "Personal" }),
						acc_b: accountFixture("acc_b", { email: "b@example.com" }),
					},
					"acc_a",
				),
			});
			authStorage = AuthStorage.create(authJsonPath);

			const refreshedAccess = codexJwt("acc_a"); // no email claim on the new token
			const refreshedRefreshTokens: string[] = [];
			stubTokenEndpoint((refreshToken) => {
				refreshedRefreshTokens.push(refreshToken);
				return { access: refreshedAccess, refresh: "refresh-acc_a-2" };
			});

			const apiKey = await authStorage.getApiKey("openai-codex");
			expect(apiKey).toBe(refreshedAccess);
			expect(refreshedRefreshTokens).toEqual(["refresh-acc_a"]);

			const onDisk = readOnDisk()["openai-codex"];
			// Only the active account was refreshed; its email/label survived.
			expect(onDisk.accountPool.accounts.acc_a.refresh).toBe("refresh-acc_a-2");
			expect(onDisk.accountPool.accounts.acc_a.email).toBe("a@example.com");
			expect(onDisk.accountPool.accounts.acc_a.label).toBe("Personal");
			// Other account untouched.
			expect(onDisk.accountPool.accounts.acc_b.refresh).toBe("refresh-acc_b");
			expect(onDisk.accountPool.accounts.acc_b.email).toBe("b@example.com");
			// Mirror follows the refreshed active account.
			expect(onDisk.refresh).toBe("refresh-acc_a-2");
			expect(onDisk.accountId).toBe("acc_a");
		});

		test("getOpenAICodexAccountApiKey refreshes a non-active account without moving the mirror", async () => {
			writeAuthJson({
				"openai-codex": pooledCredential(
					{
						acc_a: accountFixture("acc_a"),
						acc_b: accountFixture("acc_b", { expires: past(), email: "b@example.com" }),
					},
					"acc_a",
				),
			});
			authStorage = AuthStorage.create(authJsonPath);

			const refreshedAccess = codexJwt("acc_b");
			stubTokenEndpoint(() => ({ access: refreshedAccess, refresh: "refresh-acc_b-2" }));

			const result = await authStorage.getOpenAICodexAccountApiKey("acc_b");
			expect(result?.apiKey).toBe(refreshedAccess);
			expect(result?.account.email).toBe("b@example.com");

			const onDisk = readOnDisk()["openai-codex"];
			expect(onDisk.accountPool.activeAccountId).toBe("acc_a");
			expect(onDisk.refresh).toBe("refresh-acc_a");
			expect(onDisk.accountPool.accounts.acc_b.refresh).toBe("refresh-acc_b-2");
		});

		test("compareAndSetActiveOpenAICodexAccount adopts the current active account on mismatch", () => {
			writeAuthJson({
				"openai-codex": pooledCredential(
					{ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") },
					"acc_a",
				),
			});
			authStorage = AuthStorage.create(authJsonPath);

			const switched = authStorage.compareAndSetActiveOpenAICodexAccount("acc_a", "acc_b");
			expect(switched).toMatchObject({ switched: true });
			expect(switched?.account.accountId).toBe("acc_b");
			expect(authStorage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");

			// Another process already switched away from acc_a: CAS reports no-op
			// and returns the account that is actually active now.
			const adopted = authStorage.compareAndSetActiveOpenAICodexAccount("acc_a", "acc_a");
			expect(adopted).toMatchObject({ switched: false });
			expect(adopted?.account.accountId).toBe("acc_b");
			expect(authStorage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");

			expect(authStorage.compareAndSetActiveOpenAICodexAccount("acc_b", "acc_unknown")).toBeUndefined();
		});

		test("staleness is tracked per account", () => {
			authStorage = AuthStorage.inMemory({
				"openai-codex": pooledCredential(
					{ acc_a: accountFixture("acc_a"), acc_b: accountFixture("acc_b") },
					"acc_a",
				),
			});

			const token = authStorage.getCurrentAuthSourceToken("openai-codex");
			expect(token).toBeDefined();
			authStorage.markAuthSourceStale(token!);
			expect(authStorage.hasAuth("openai-codex")).toBe(false);

			// Switching accounts changes the credential identity: the stale mark
			// on acc_a must not poison acc_b.
			authStorage.setActiveOpenAICodexAccount("acc_b");
			expect(authStorage.hasAuth("openai-codex")).toBe(true);
		});

		test("snapshotOpenAICodexPool re-reads under the lock and observes another instance's writes", () => {
			writeAuthJson({ "openai-codex": pooledCredential({ acc_a: accountFixture("acc_a") }, "acc_a") });
			const storageA = AuthStorage.create(authJsonPath);
			const storageB = AuthStorage.create(authJsonPath);

			// B adds and activates a subscription; A's in-memory cache is stale.
			storageB.upsertOpenAICodexAccount(accountFixture("acc_b", { email: "b@example.com" }));
			expect(storageA.listOpenAICodexAccounts().map((a) => a.accountId)).toEqual(["acc_a"]);

			const snapshot = storageA.snapshotOpenAICodexPool();
			expect(snapshot?.accounts.map((a) => a.accountId).sort()).toEqual(["acc_a", "acc_b"]);
			expect(snapshot?.activeAccountId).toBe("acc_b");

			// The snapshot refreshed A's cached view as a side effect.
			expect(storageA.getActiveOpenAICodexAccount()?.accountId).toBe("acc_b");
		});

		test("a pool with a broken activeAccountId pointer is repaired without losing accounts", () => {
			writeAuthJson({
				"openai-codex": {
					type: "oauth",
					...accountFixture("acc_a", { email: "a@example.com" }),
					accountPool: {
						schemaVersion: 1,
						activeAccountId: "acc_missing",
						accounts: {
							acc_a: accountFixture("acc_a", { email: "a@example.com" }),
							acc_b: accountFixture("acc_b"),
						},
					},
				},
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.reload();

			const onDisk = readOnDisk()["openai-codex"];
			// Repaired in place: both nested accounts (and their refresh tokens)
			// survive; only the dangling pointer is re-pointed.
			expect(Object.keys(onDisk.accountPool.accounts).sort()).toEqual(["acc_a", "acc_b"]);
			expect(onDisk.accountPool.accounts.acc_b.refresh).toBe("refresh-acc_b");
			expect(["acc_a", "acc_b"]).toContain(onDisk.accountPool.activeAccountId);
			expect(
				authStorage
					.listOpenAICodexAccounts()
					.map((a) => a.accountId)
					.sort(),
			).toEqual(["acc_a", "acc_b"]);
		});

		test("an unsalvageable pool is preserved on disk instead of being rebuilt", () => {
			const mirror = accountFixture("acc_a", { email: "a@example.com" });
			writeAuthJson({
				"openai-codex": {
					type: "oauth",
					...mirror,
					// Unknown schema + non-object accounts: nothing safely repairable.
					accountPool: { schemaVersion: 2, activeAccountId: "acc_a", accounts: "bogus" },
				},
			});
			const before = readFileSync(authJsonPath, "utf-8");

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.reload();

			// No destructive rewrite: the malformed pool survives byte-for-byte.
			expect(readFileSync(authJsonPath, "utf-8")).toBe(before);
			// Reads fall back to the top-level mirror account.
			expect(authStorage.listOpenAICodexAccounts().map((a) => a.accountId)).toEqual(["acc_a"]);
			expect(authStorage.getActiveOpenAICodexAccount()?.accountId).toBe("acc_a");
			expect(authStorage.getActiveOpenAICodexAccount()?.email).toBe("a@example.com");
		});

		test("upsert refuses to overwrite an unsalvageable pool", () => {
			writeAuthJson({
				"openai-codex": {
					type: "oauth",
					...accountFixture("acc_a"),
					accountPool: { schemaVersion: 2, activeAccountId: "acc_a", accounts: "bogus" },
				},
			});
			authStorage = AuthStorage.create(authJsonPath);

			expect(() => authStorage.upsertOpenAICodexAccount(accountFixture("acc_c"))).toThrow(/malformed/);

			const onDisk = readOnDisk()["openai-codex"];
			expect(onDisk.accountPool.schemaVersion).toBe(2);
			expect(onDisk.accountPool.accounts).toBe("bogus");
		});

		test("legacy migration backfills email from the access token claim", () => {
			writeAuthJson({
				"openai-codex": {
					type: "oauth",
					access: codexJwt("acc_a", "migrated@example.com"),
					refresh: "refresh-acc_a",
					expires: future(),
					accountId: "acc_a",
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.listOpenAICodexAccounts()[0]?.email).toBe("migrated@example.com");
			expect(readOnDisk()["openai-codex"].accountPool.accounts.acc_a.email).toBe("migrated@example.com");
		});

		test("backfills a missing email from the access token on next use", async () => {
			// The stored account record lacks email, but its access token carries
			// the email claim.
			writeAuthJson({
				"openai-codex": pooledCredential(
					{
						acc_a: {
							access: codexJwt("acc_a", "backfill@example.com"),
							refresh: "refresh-acc_a",
							expires: future(),
							accountId: "acc_a",
						},
					},
					"acc_a",
				),
			});
			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.listOpenAICodexAccounts()[0]?.email).toBeUndefined();

			const result = await authStorage.getOpenAICodexAccountApiKey("acc_a");

			expect(result?.account.email).toBe("backfill@example.com");
			expect(readOnDisk()["openai-codex"].accountPool.accounts.acc_a.email).toBe("backfill@example.com");
		});
	});
});

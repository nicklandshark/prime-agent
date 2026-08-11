/**
 * Cursor cloud environment registry + server listing.
 *
 * The local tunnel registry (~/.prime/agent/cursor-cloud.json, mode 0600)
 * records which Cursor cloud agents this machine can reach over SSH and how
 * (bore.pub tunnel or tailscale). The Cursor Cloud Agents API is the server
 * truth for which agents still exist; there is no /v1/environments endpoint,
 * so environments are derived by joining the registry onto GET /v1/agents.
 *
 * Secrets are never logged or embedded in error messages.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export const CURSOR_CLOUD_REGISTRY_FILENAME = "cursor-cloud.json";
export const CURSOR_CLOUD_API_BASE_URL = "https://api.cursor.com";
export const CURSOR_CLOUD_PROVIDER_ID = "cursor";
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_PAGES = 20;

/** One entry in the local tunnel registry's `tunnels` map, keyed by name. */
export interface CursorCloudTunnelRegistryEntry {
	agent_id: string;
	repo?: string;
	ssh_host?: string;
	ssh_port?: number;
	ssh_user?: string;
	via?: string;
	tailscale_ip?: string;
	created_at?: string;
	last_verified_at?: string;
}

/** Subset of the Cursor Cloud Agents API AgentSummary consumed by the viewer. */
export interface CursorCloudAgentSummary {
	id: string;
	name?: string;
	status?: string;
	env?: unknown;
	url?: string;
	createdAt?: string;
	updatedAt?: string;
	latestRunId?: string;
}

/**
 * Server-side truth for a view row:
 * - ACTIVE / ARCHIVED: the agent exists server-side with that status.
 * - "missing": the registry references an agent the server no longer returns.
 * - "unregistered": the server returns an agent with no local registry entry.
 * - "unknown": registry-only view (server not queried yet or unreachable).
 */
export type CursorCloudServerStatus = "ACTIVE" | "ARCHIVED" | "missing" | "unregistered" | "unknown";

/** A row in the /cursor-cloud viewer: registry data joined with server state. */
export interface CursorCloudEnvironmentView {
	name: string;
	agentId: string;
	repo?: string;
	via?: string;
	/** `host:port@user` built from the registry tunnel entry. */
	sshTarget?: string;
	serverStatus: CursorCloudServerStatus;
	lastVerifiedAt?: string;
	latestRunId?: string;
}

export interface CursorCloudEnvironmentsResult {
	environments: CursorCloudEnvironmentView[];
	/** Human-readable note when server data is unavailable (views are registry-only). */
	serverError?: string;
}

export interface ListCursorCloudAgentsOptions {
	apiKey: string;
	baseUrl?: string;
	limit?: number;
	maxPages?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export interface ListCursorCloudEnvironmentsOptions {
	agentDir?: string;
	apiKey?: string;
	baseUrl?: string;
	/** Also list server agents that have no local registry entry. Default: true. */
	includeUnregistered?: boolean;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

/** Read the local tunnel registry. Missing or malformed files yield an empty map. */
export function readCursorCloudRegistry(
	agentDir: string = getAgentDir(),
): Record<string, CursorCloudTunnelRegistryEntry> {
	let raw: string;
	try {
		raw = readFileSync(join(agentDir, CURSOR_CLOUD_REGISTRY_FILENAME), "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") {
		return {};
	}
	const tunnels = (parsed as { tunnels?: unknown }).tunnels;
	if (!tunnels || typeof tunnels !== "object" || Array.isArray(tunnels)) {
		return {};
	}
	const registry: Record<string, CursorCloudTunnelRegistryEntry> = {};
	for (const [name, entry] of Object.entries(tunnels as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Partial<CursorCloudTunnelRegistryEntry>;
		if (typeof candidate.agent_id !== "string" || candidate.agent_id.length === 0) continue;
		registry[name] = { ...candidate, agent_id: candidate.agent_id };
	}
	return registry;
}

/**
 * Resolve the Cursor API key: CURSOR_API_KEY env first, then the `cursor`
 * api_key entry in auth.json (which may itself reference an env var or a
 * `!command`). Returns undefined when nothing is configured; never throws.
 */
export function resolveCursorCloudApiKey(agentDir: string = getAgentDir()): string | undefined {
	const fromEnv = process.env[CURSOR_API_KEY_ENV]?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	let raw: string;
	try {
		raw = readFileSync(join(agentDir, "auth.json"), "utf-8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const credential = parsed?.[CURSOR_CLOUD_PROVIDER_ID];
		if (!credential || typeof credential !== "object") {
			return undefined;
		}
		const { type, key } = credential as { type?: unknown; key?: unknown };
		if (type !== "api_key" || typeof key !== "string" || key.length === 0) {
			return undefined;
		}
		return resolveConfigValue(key)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Build the `host:port@user` SSH target for a registry entry. */
export function formatCursorCloudSshTarget(entry: CursorCloudTunnelRegistryEntry): string | undefined {
	const host = entry.ssh_host ?? entry.tailscale_ip;
	if (!host) {
		return undefined;
	}
	const port = entry.ssh_port ?? 22;
	return entry.ssh_user ? `${host}:${port}@${entry.ssh_user}` : `${host}:${port}`;
}

/** Fetch every cloud agent (including archived) from the Cursor API, paging via nextCursor. */
export async function listCursorCloudAgents(options: ListCursorCloudAgentsOptions): Promise<CursorCloudAgentSummary[]> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = (options.baseUrl ?? CURSOR_CLOUD_API_BASE_URL).replace(/\/+$/, "");
	const limit = options.limit ?? DEFAULT_LIST_LIMIT;
	const maxPages = options.maxPages ?? MAX_LIST_PAGES;
	const authorization = `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`;

	const agents: CursorCloudAgentSummary[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const params = new URLSearchParams({ includeArchived: "true", limit: String(limit) });
		if (cursor) {
			params.set("cursor", cursor);
		}
		const response = await fetchImpl(`${baseUrl}/v1/agents?${params.toString()}`, {
			method: "GET",
			headers: { authorization },
			signal: options.signal,
		});
		if (!response.ok) {
			throw new Error(`Cursor Cloud Agents API error (HTTP ${response.status})`);
		}
		const body = (await response.json()) as { items?: unknown; nextCursor?: unknown };
		const items = Array.isArray(body.items) ? body.items : [];
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			const summary = item as Partial<CursorCloudAgentSummary>;
			if (typeof summary.id !== "string" || summary.id.length === 0) continue;
			agents.push(summary as CursorCloudAgentSummary);
		}
		if (typeof body.nextCursor !== "string" || body.nextCursor.length === 0) {
			break;
		}
		cursor = body.nextCursor;
	}
	return agents;
}

/**
 * Join the local registry with the server agent list on agent_id. Pass
 * `agents` as undefined when the server was not queried (or unreachable) to
 * get a registry-only view with serverStatus "unknown".
 */
export function joinCursorCloudEnvironments(
	registry: Record<string, CursorCloudTunnelRegistryEntry>,
	agents: CursorCloudAgentSummary[] | undefined,
	options: { includeUnregistered?: boolean } = {},
): CursorCloudEnvironmentView[] {
	const byAgentId = new Map<string, CursorCloudAgentSummary>();
	for (const agent of agents ?? []) {
		byAgentId.set(agent.id, agent);
	}

	const views: CursorCloudEnvironmentView[] = [];
	const names = Object.keys(registry).sort((a, b) => a.localeCompare(b));
	for (const name of names) {
		const entry = registry[name];
		const agent = byAgentId.get(entry.agent_id);
		const serverStatus: CursorCloudServerStatus =
			agents === undefined ? "unknown" : agent ? normalizeServerStatus(agent.status) : "missing";
		views.push({
			name,
			agentId: entry.agent_id,
			repo: entry.repo,
			via: entry.via,
			sshTarget: formatCursorCloudSshTarget(entry),
			serverStatus,
			lastVerifiedAt: entry.last_verified_at,
			latestRunId: agent?.latestRunId,
		});
		if (agent) {
			byAgentId.delete(entry.agent_id);
		}
	}

	if (options.includeUnregistered !== false && agents !== undefined) {
		const unregistered = [...byAgentId.values()].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
		for (const agent of unregistered) {
			views.push({
				name: agent.name ?? agent.id,
				agentId: agent.id,
				serverStatus: "unregistered",
				latestRunId: agent.latestRunId,
			});
		}
	}
	return views;
}

/** Registry-only views for immediate display before the server responds. */
export function getCachedCursorCloudEnvironments(agentDir: string = getAgentDir()): CursorCloudEnvironmentView[] {
	return joinCursorCloudEnvironments(readCursorCloudRegistry(agentDir), undefined);
}

/**
 * Full environment listing: registry joined with live server data. Network or
 * auth failures fall back to a registry-only view with a `serverError` note;
 * abort errors are rethrown so callers can distinguish cancellation.
 */
export async function listCursorCloudEnvironments(
	options: ListCursorCloudEnvironmentsOptions = {},
): Promise<CursorCloudEnvironmentsResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const registry = readCursorCloudRegistry(agentDir);
	const registryOnly = () => joinCursorCloudEnvironments(registry, undefined, options);

	const apiKey = options.apiKey ?? resolveCursorCloudApiKey(agentDir);
	if (!apiKey) {
		return {
			environments: registryOnly(),
			serverError: `no Cursor API key (set ${CURSOR_API_KEY_ENV} or add a "${CURSOR_CLOUD_PROVIDER_ID}" credential via /login)`,
		};
	}
	try {
		const agents = await listCursorCloudAgents({
			apiKey,
			baseUrl: options.baseUrl,
			signal: options.signal,
			fetchImpl: options.fetchImpl,
		});
		return { environments: joinCursorCloudEnvironments(registry, agents, options) };
	} catch (error) {
		if (options.signal?.aborted) {
			throw error;
		}
		return {
			environments: registryOnly(),
			serverError: `server unreachable (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

function normalizeServerStatus(status: string | undefined): CursorCloudServerStatus {
	return status === "ACTIVE" || status === "ARCHIVED" ? status : "unknown";
}

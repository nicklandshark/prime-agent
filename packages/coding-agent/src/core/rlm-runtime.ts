import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isValidThinkingLevel, VALID_THINKING_LEVELS } from "../cli/args.js";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import type { HostRequestHandler } from "./kernel/index.js";

/** Request emitted by `rlm.run`; cellSourceCode preserves the spawning cell for display. */
export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	cellSourceCode?: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
	/** Reasoning level the child actually runs at, after clamping to what its model supports. */
	thinking: ThinkingLevel;
	/** Whether the child actually runs on the fast tier, after clamping to what its model supports. */
	fast: boolean;
	/** Named Cursor cloud environment the child was spawned into, when the environment kwarg was used. */
	cursor_environment?: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

export function normalizeRequestedRlmSubagentSessionName(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run name must be a string");
	}
	const name = value.trim();
	if (!name) {
		throw new Error("rlm.run name must not be empty");
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function normalizeRequestedRlmSubagentModel(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run model must be a string");
	}
	const model = value.trim();
	if (!model) {
		throw new Error("rlm.run model must not be empty");
	}
	return model;
}

/**
 * Validate an orchestrator-supplied subagent reasoning level.
 *
 * The level is the one the caller asks for, not necessarily the one the child gets: a model that
 * publishes a narrower ladder clamps it at spawn time, and the resolved level comes back on the
 * spawn handle.
 */
export function normalizeRequestedRlmSubagentThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run thinking must be a string");
	}
	const level = value.trim().toLowerCase();
	if (!isValidThinkingLevel(level)) {
		throw new Error(`rlm.run thinking must be one of: ${VALID_THINKING_LEVELS.join(", ")}`);
	}
	return level;
}

/**
 * Validate an orchestrator-supplied fast-tier request and map it onto a service tier.
 *
 * Three states, all meaningful: omitted inherits the parent's tier, `True` asks for the fast tier
 * even from a parent that is not on it, and `False` keeps a child off the fast tier its parent is
 * paying for. The service tier is the internal vocabulary, but only "priority" is reachable from
 * the CLI, the TUI and settings, so a boolean says exactly as much and reads better at a spawn.
 */
export function normalizeRequestedRlmSubagentFastMode(value: unknown): ServiceTier | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error("rlm.run fast must be a boolean");
	}
	return value ? "priority" : "default";
}

/** Provider id of Cursor cloud agent models (e.g. cursor/cloud-agent). */
export const CURSOR_CLOUD_PROVIDER_ID = "cursor";

/**
 * Cursor cloud environment targeting for a spawned subagent.
 *
 * Only meaningful when the resolved child model belongs to the cursor provider; the spawn
 * path rejects these kwargs for any other model instead of silently dropping them.
 *
 * A named `environment` is mutually exclusive with `repos`: the environment has its repos
 * baked in, so when it is present it wins and repos/tunnel are dropped.
 */
export interface RlmCursorCloudTarget {
	/** Named cloud environment (`env: {type: "cloud", name}`) to create the child agent in. */
	environment?: string;
	/** GitHub repo URLs cloned into the cloud VM for an unnamed environment. */
	repos?: string[];
	/** Tunnel preamble preference for newly created agents; the provider default applies when unset. */
	tunnel?: boolean;
}

/** Validate and normalize an orchestrator-supplied Cursor cloud environment name. */
export function normalizeRequestedRlmSubagentCursorEnvironment(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run environment must be a string");
	}
	const environment = value.trim();
	if (!environment) {
		throw new Error("rlm.run environment must not be empty");
	}
	return environment;
}

/** Validate and normalize orchestrator-supplied GitHub repos for a fresh Cursor cloud environment. */
export function normalizeRequestedRlmSubagentCursorRepos(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new Error("rlm.run repos must be an array of GitHub repository URLs");
	}
	const repos = value.map((entry) => {
		if (typeof entry !== "string") {
			throw new Error("rlm.run repos must be an array of GitHub repository URLs");
		}
		const repo = entry.trim();
		if (!repo) {
			throw new Error("rlm.run repos must not contain empty entries");
		}
		return repo;
	});
	if (repos.length === 0) {
		throw new Error("rlm.run repos must not be empty");
	}
	return repos;
}

/** Validate an orchestrator-supplied tunnel preference for newly created Cursor cloud agents. */
export function normalizeRequestedRlmSubagentCursorTunnel(value: unknown): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error("rlm.run tunnel must be a boolean");
	}
	return value;
}

/**
 * Bind a child agent's stream function to a Cursor cloud environment target.
 *
 * Cursor models receive the target on every stream call as provider options
 * (`environment`, or `repos`/`tunnel` when no named environment was requested), which the
 * cursor provider's streamSimple maps onto its CursorOptions. A named environment is
 * mutually exclusive with repos, so it is injected alone. Models from any other provider
 * pass through untouched, so a child that switches models mid-run never leaks the target
 * into a non-cursor request.
 */
export function wrapRlmSubagentStreamFnWithCursorTarget(streamFn: StreamFn, target: RlmCursorCloudTarget): StreamFn {
	return (model, context, options) => {
		if (model.provider !== CURSOR_CLOUD_PROVIDER_ID) {
			return streamFn(model, context, options);
		}
		const targeted = {
			...options,
			...(target.environment ? { environment: target.environment } : {}),
			...(!target.environment && target.repos ? { repos: target.repos } : {}),
			...(!target.environment && target.tunnel !== undefined ? { tunnel: target.tunnel } : {}),
		} as SimpleStreamOptions;
		return streamFn(model, context, targeted);
	};
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/** Adapt an RlmRunHandler into the typed `rlm.run` kernel host handler. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({
			prompt: payload.prompt,
			kwargs,
			cellSourceCode,
		});
		return result as unknown as Record<string, unknown>;
	};
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}

/** Expose the current parent session's direct RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return async () => {
		const { subagents } = await handler();
		return { subagents };
	};
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim());
		return outcome === undefined ? { subagent } : { subagent, outcome };
	};
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/**
	 * Cursor cloud environment target for the child. Only set when the resolved child model
	 * belongs to the cursor provider; the spawn path rejects it for any other model.
	 */
	cursor?: RlmCursorCloudTarget;
	/** Source of the IPython cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}

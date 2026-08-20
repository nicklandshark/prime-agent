/**
 * Session-local effective context windows.
 *
 * A context window is local metadata: no provider payload transmits it. It
 * drives compaction thresholds, overflow recovery, retry classification and
 * the /context report. That makes it safe to override per session, but only
 * per session: ModelRegistry entries and catalog model objects are shared with
 * every other session in the process (RLM subagents read the same objects), so
 * nothing here clones or mutates a model.
 */

/** Minimal model shape the effective-window helpers need. */
interface ContextWindowModel {
	provider: string;
	contextWindow: number;
}

/**
 * Effective context windows for one session, keyed by provider id.
 *
 * Keying by provider rather than by model id is deliberate: /model can replace
 * the session's model at any time, and the override must follow every model of
 * that provider while leaving other providers reporting their raw catalog
 * window.
 */
export type ContextWindowOverrides = Readonly<Record<string, number>>;

/** Provider id of ChatGPT/Codex subscription models. */
const OPENAI_CODEX_PROVIDER = "openai-codex";

/**
 * Effective context window the top-level agent uses for OpenAI Codex models.
 *
 * The generated catalog reports the raw provider window (272000, or 128000 for
 * Spark) and stays untouched. Only the root agent plans against 1M; RLM
 * subagents keep the raw value so their budgets and /context stay truthful.
 */
export const ROOT_OPENAI_CODEX_CONTEXT_WINDOW = 1_000_000;

/**
 * Overrides for a CLI/daemon-created session, gated on RLM depth.
 *
 * Returns undefined for every subagent depth, so a child keeps the raw catalog
 * window whether it inherited the parent's model or selected one explicitly.
 */
export function rootContextWindowOverrides(rlmDepth: number | undefined): ContextWindowOverrides | undefined {
	if ((rlmDepth ?? 0) !== 0) {
		return undefined;
	}
	return { [OPENAI_CODEX_PROVIDER]: ROOT_OPENAI_CODEX_CONTEXT_WINDOW };
}

/**
 * Session-local override for `model`, or undefined when the raw catalog window
 * applies. Non-positive entries are ignored rather than trusted.
 */
export function contextWindowOverrideFor(
	model: ContextWindowModel | undefined,
	overrides: ContextWindowOverrides | undefined,
): number | undefined {
	if (!model || !overrides) {
		return undefined;
	}
	const override = overrides[model.provider];
	return typeof override === "number" && override > 0 ? override : undefined;
}

/** Effective window for `model`: the session-local override, else the catalog value. */
export function effectiveContextWindowFor(
	model: ContextWindowModel | undefined,
	overrides: ContextWindowOverrides | undefined,
): number {
	return contextWindowOverrideFor(model, overrides) ?? model?.contextWindow ?? 0;
}

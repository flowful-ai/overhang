// Cost accounting for the live eval runner, kept free of side effects so the
// cost-cap decision can be unit tested.

// When OpenRouter doesn't report cost, estimate pessimistically so the cap
// still binds (rates in USD per million tokens, above flash-class pricing).
const FALLBACK_IN_PER_MTOK = 1;
const FALLBACK_OUT_PER_MTOK = 5;

/** Usage of one completed model step, as reported on its finish-step part. */
export interface StepUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * OpenRouter's reported cost for the step (usage.raw.cost). It already
   * includes web search fees: on a live GPT-5.6 Luna step with
   * web_search_requests: 1, cost was prompt + completion + exactly $0.01 (the
   * provider's per-search price), so `--web-search` runs stay under the cap.
   */
  costUsd: number | null;
}

/** Token counts across AI SDK usage shapes (flat number or nested { total }). */
function tokenCount(usage: unknown, key: "inputTokens" | "outputTokens"): number | null {
  const v = (usage as Record<string, unknown> | undefined)?.[key];
  if (typeof v === "number") return v;
  if (v && typeof (v as { total?: unknown }).total === "number") return (v as { total: number }).total;
  return null;
}

/** Read one step's usage from the AI SDK usage object of a finish-step part. */
export function stepUsage(usage: unknown): StepUsage {
  const cost = (usage as { raw?: { cost?: unknown } } | undefined)?.raw?.cost;
  return {
    inputTokens: tokenCount(usage, "inputTokens"),
    outputTokens: tokenCount(usage, "outputTokens"),
    costUsd: typeof cost === "number" ? cost : null,
  };
}

export type CostDecision =
  /** Add `costUsd` to the run's spend and keep going. */
  | { action: "count"; costUsd: number }
  /** A model call completed without any usage: the cost cap cannot be enforced. */
  | { action: "stop" };

/**
 * Whether a case's spend can be counted against the cost cap.
 *
 * No completed step (the worker was down, or the turn failed before a model
 * step finished): nothing to count, keep going. Every completed step reported
 * usage: count the reported cost, or a pessimistic estimate from tokens. Any
 * completed step without usage: stop, because counting it as free would let
 * the cap pass silently.
 */
export function caseCostDecision(steps: readonly StepUsage[]): CostDecision {
  let costUsd = 0;
  for (const step of steps) {
    if (step.costUsd !== null) {
      costUsd += step.costUsd;
    } else if (step.inputTokens !== null || step.outputTokens !== null) {
      costUsd +=
        ((step.inputTokens ?? 0) / 1e6) * FALLBACK_IN_PER_MTOK + ((step.outputTokens ?? 0) / 1e6) * FALLBACK_OUT_PER_MTOK;
    } else {
      return { action: "stop" };
    }
  }
  return { action: "count", costUsd };
}

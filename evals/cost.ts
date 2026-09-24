// Cost accounting for the live eval runner, kept free of side effects so the
// cost-cap decision can be unit tested.

import type { StepUsage } from "../src/lib/usage";

// Per-step usage parsing is shared with the agent turn's usage log. The
// reported cost includes web search fees, so `--web-search` runs stay under
// the cap.
export { stepUsage, type StepUsage } from "../src/lib/usage";

// When OpenRouter doesn't report cost, estimate pessimistically so the cap
// still binds (rates in USD per million tokens, above flash-class pricing).
const FALLBACK_IN_PER_MTOK = 1;
const FALLBACK_OUT_PER_MTOK = 5;

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

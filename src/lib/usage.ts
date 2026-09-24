// Token and cost accounting for one model step, shared by the agent turn's
// usage log (agent-turn.ts) and the eval runner's cost cap (evals/cost.ts).

/** Usage of one completed model step, as reported on its finish-step part. */
export interface StepUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * OpenRouter's reported cost for the step (usage.raw.cost, with
   * includeUsage). It already includes web search fees: on a live GPT-5.6
   * Luna step with web_search_requests: 1, cost was prompt + completion +
   * exactly $0.01 (the provider's per-search price).
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

/** Read one step's usage from an AI SDK usage object (a finish-step part's, or a StepResult's). */
export function stepUsage(usage: unknown): StepUsage {
  const cost = (usage as { raw?: { cost?: unknown } } | undefined)?.raw?.cost;
  return {
    inputTokens: tokenCount(usage, "inputTokens"),
    outputTokens: tokenCount(usage, "outputTokens"),
    costUsd: typeof cost === "number" ? cost : null,
  };
}

/** Sum of `key` over the steps that reported it, or null when none did. */
export function sumReported(steps: readonly StepUsage[], key: keyof StepUsage): number | null {
  let total: number | null = null;
  for (const step of steps) {
    const v = step[key];
    if (v !== null) total = (total ?? 0) + v;
  }
  return total;
}

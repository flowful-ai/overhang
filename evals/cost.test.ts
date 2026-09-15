import { describe, expect, it } from "vitest";
import { caseCostDecision, stepUsage } from "./cost";

describe("caseCostDecision", () => {
  it("keeps going with nothing to count when no model step completed (e.g. worker down, early failure)", () => {
    expect(caseCostDecision([])).toEqual({ action: "count", costUsd: 0 });
  });

  it("counts OpenRouter's reported cost when every step reports it", () => {
    const decision = caseCostDecision([
      { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 },
      { inputTokens: 1500, outputTokens: 100, costUsd: 0.02 },
    ]);
    expect(decision.action).toBe("count");
    expect(decision.action === "count" && decision.costUsd).toBeCloseTo(0.03);
  });

  it("estimates pessimistically from tokens when cost is not reported", () => {
    // 1M input at $1/M + 1M output at $5/M
    expect(caseCostDecision([{ inputTokens: 1_000_000, outputTokens: 1_000_000, costUsd: null }])).toEqual({
      action: "count",
      costUsd: 6,
    });
  });

  it("stops when a completed step reported no usage at all", () => {
    expect(caseCostDecision([{ inputTokens: null, outputTokens: null, costUsd: null }])).toEqual({ action: "stop" });
    expect(
      caseCostDecision([
        { inputTokens: 10, outputTokens: 10, costUsd: 0.001 },
        { inputTokens: null, outputTokens: null, costUsd: null },
      ]),
    ).toEqual({ action: "stop" });
  });
});

describe("stepUsage", () => {
  it("reads nested and flat token counts and OpenRouter's raw cost", () => {
    expect(stepUsage({ inputTokens: { total: 12 }, outputTokens: 3, raw: { cost: 0.004 } })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      costUsd: 0.004,
    });
    expect(stepUsage(undefined)).toEqual({ inputTokens: null, outputTokens: null, costUsd: null });
  });
});

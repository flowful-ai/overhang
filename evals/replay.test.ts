import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MAX_AGENT_STEPS } from "../src/components/chat/constants";
import { runAgentTurn, type AgentWorker } from "../src/lib/agent-turn";
import type { BoundingBox } from "../src/lib/cad-worker-protocol";
import { EVAL_CASES } from "./cases";
import { loadFixtures, type Fixture, type LlmStepFixture } from "./recorder";
import { scoreCase } from "./scoring";

// Hermetic replay of recorded eval fixtures: the LLM steps come from the
// fixture (mock model), the worker responses come from the fixture (worker
// adapter), and the real agent turn + scoring pipeline runs in between, through
// the same runAgentTurn the route and the live runner use.
// Guards the harness wiring and scoring, NOT model behavior. That's what the
// live `npm run eval` measures.

const NO_TOKENS = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function streamPartsForStep(step: LlmStepFixture, index: number): LanguageModelV3StreamPart[] {
  const textId = `text-${index}`;
  return [
    { type: "stream-start", warnings: [] },
    ...(step.text
      ? ([
          { type: "text-start", id: textId },
          { type: "text-delta", id: textId, delta: step.text },
          { type: "text-end", id: textId },
        ] as const)
      : []),
    ...step.toolCalls.map((tc) => ({
      type: "tool-call" as const,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: JSON.stringify(tc.input),
    })),
    {
      type: "finish",
      // Fixtures store the unified reason as a bare string; the V3 part wants
      // the object shape (newer SDK versions only run tools when unified is set).
      finishReason: {
        unified: step.finishReason as Extract<LanguageModelV3StreamPart, { type: "finish" }>["finishReason"]["unified"],
        raw: step.finishReason,
      },
      usage: NO_TOKENS,
    },
  ];
}

// The recorded steps are replayed verbatim, so the mock cannot honor
// toolChoice (fixtures that used every step were recorded before the final
// step disabled tools). It records what each call was offered instead, and the
// test asserts what the turn passed on every step.
function mockModelFromFixture(fixture: Fixture, calls: LanguageModelV3CallOptions[]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    modelId: fixture.model,
    doStream: async (options: LanguageModelV3CallOptions) => {
      calls.push(options);
      const index = call++;
      const step = fixture.llmSteps[index];
      if (!step) throw new Error(`Mock LLM exhausted after ${fixture.llmSteps.length} steps`);
      return { stream: simulateReadableStream({ chunks: streamPartsForStep(step, index) }) };
    },
  });
}

const fixtures = loadFixtures();

describe("eval fixture replay", () => {
  it("has a valid fixture set (empty is OK before the first --record run)", () => {
    // loadFixtures() already schema-validates and throws on a corrupt file,
    // so importing this module is itself the check.
    expect(Array.isArray(fixtures)).toBe(true);
  });

  for (const fixture of fixtures) {
    it(`${fixture.caseId} (${fixture.model}) replays to the recorded score`, async () => {
      const evalCase = EVAL_CASES.find((c) => c.id === fixture.caseId);
      if (!evalCase) throw new Error(`Fixture ${fixture.caseId} has no matching case in cases.ts`);

      let workerIdx = 0;
      const codeMismatches: Array<{ call: number; sent: string; recorded: string }> = [];
      const workerSignals: Array<AbortSignal | undefined> = [];
      let lastRender: { bbox: BoundingBox; warnings: string[] } | null = null;
      const worker: AgentWorker = {
        ping: async () => true,
        render: async (code, _requestId, options) => {
          workerSignals.push(options?.signal);
          const call = workerIdx++;
          const recorded = fixture.workerCalls[call];
          if (!recorded) throw new Error("More worker calls than recorded");
          // Same code must reach the worker as during recording (this pins
          // normalizePunctuation and the tool plumbing). Recorded and asserted
          // after the turn: a throw here would be swallowed into a tool failure.
          if (code !== recorded.code) codeMismatches.push({ call, sent: code, recorded: recorded.code });
          if (!recorded.ok) throw new Error(recorded.error);
          return recorded.response;
        },
      };

      const calls: LanguageModelV3CallOptions[] = [];
      const onSettled = vi.fn();
      const turn = await runAgentTurn({
        model: mockModelFromFixture(fixture, calls),
        prompt: evalCase.prompt,
        worker,
        requestId: `replay-${fixture.caseId}`,
        onRender: ({ bbox, warnings }) => {
          lastRender = { bbox, warnings };
        },
        onSettled,
      });
      if (!turn.ok) throw new Error("fake worker reported unavailable");

      const streamErrors: unknown[] = [];
      for await (const part of turn.stream.fullStream) {
        if (part.type === "error" || part.type === "abort") streamErrors.push(part);
      }

      expect(streamErrors).toEqual([]);
      expect(onSettled).toHaveBeenCalledOnce();
      expect(codeMismatches).toEqual([]);
      expect(workerIdx).toBe(fixture.workerCalls.length);

      // Tools stay on until the last allowed step, then the turn turns them off.
      expect(calls).toHaveLength(fixture.llmSteps.length);
      calls.forEach((options, step) =>
        expect(options.toolChoice?.type).toBe(step === MAX_AGENT_STEPS - 1 ? "none" : "auto"),
      );

      // Per-model provider options come from the model id the adapter reports.
      const expectedProviderOptions = fixture.model.startsWith("anthropic/")
        ? { openrouter: { reasoning: { max_tokens: 2048 } } }
        : undefined;
      for (const options of calls) {
        expect(options.providerOptions).toEqual(expectedProviderOptions);
        // The turn's abort signal reaches the model call...
        expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      }
      // ...and every worker call.
      for (const signal of workerSignals) {
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal?.aborted).toBe(false);
      }

      const render = lastRender as { bbox: BoundingBox; warnings: string[] } | null;
      const score = scoreCase(evalCase.expect, {
        rendered: render !== null,
        bbox: render?.bbox ?? null,
        warnings: render?.warnings ?? [],
      });
      expect(score).toEqual(fixture.score);
    });
  }
});

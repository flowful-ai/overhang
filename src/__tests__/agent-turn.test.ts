import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MAX_AGENT_STEPS } from "@/components/chat/constants";
import { AGENT_TURN_TIMEOUT_MS, openRouterModel, runAgentTurn, type AgentWorker } from "@/lib/agent-turn";
import type { WorkerRenderResult } from "@/lib/cad-worker-protocol";
import { ALLOWED_MODEL_IDS, allowedModelId } from "@/lib/utils";

// The agent turn tested at its interface: a mock model, a fake worker adapter,
// and the stream the callers consume.

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;
const CUBE = "import cadquery as cq\nresult = cq.Workplane().box(10,10,10)";
const STL = "STL_PAYLOAD_THAT_MUST_NOT_REACH_THE_MODEL";
// No timer-based delays, so the timeout test can fake setTimeout.
const NO_DELAY = { initialDelayInMs: null, chunkDelayInMs: null };

type DoStream = (options: LanguageModelV3CallOptions) => Promise<{ stream: ReadableStream<LanguageModelV3StreamPart> }>;

function toolStep(id: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: id, toolName: "runCadquery", input: JSON.stringify({ code: CUBE }) },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

function textStep(): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "Done." },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

/** Serves the scripted steps in order, then text-only steps. */
function scripted(steps: LanguageModelV3StreamPart[][]) {
  let i = 0;
  return vi.fn<DoStream>(async () => ({
    stream: simulateReadableStream({ chunks: steps[i++] ?? textStep(), ...NO_DELAY }),
  }));
}

function okRender(): WorkerRenderResult {
  return {
    stl_base64: STL,
    warnings: [],
    console_output: null,
    metrics: { bbox: { x: 10, y: 10, z: 10 }, volume: 1000 },
  };
}

function fakeWorker(overrides: Partial<AgentWorker> = {}): AgentWorker {
  return { ping: async () => true, render: async () => okRender(), ...overrides };
}

/** A render that only ends when its abort signal fires, like a slow worker. */
function hangingRender() {
  let markStarted!: (signal: AbortSignal | undefined) => void;
  const started = new Promise<AbortSignal | undefined>((resolve) => (markStarted = resolve));
  const render = vi.fn<AgentWorker["render"]>(
    (_code, _requestId, options) =>
      new Promise<WorkerRenderResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("CAD worker request aborted")), { once: true });
        markStarted(options?.signal);
      }),
  );
  return { render, started };
}

async function startedTurn(options: Parameters<typeof runAgentTurn>[0]) {
  const turn = await runAgentTurn(options);
  if (!turn.ok) throw new Error(`turn refused: ${turn.reason}`);
  return turn.stream;
}

describe("runAgentTurn", () => {
  it("caps the turn at MAX_AGENT_STEPS and disables tools on the final step", async () => {
    let i = 0;
    const doStream = vi.fn<DoStream>(async () => ({ stream: simulateReadableStream({ chunks: toolStep(`c${i++}`) }) }));
    const stream = await startedTurn({
      model: new MockLanguageModelV3({ doStream }),
      prompt: "make a cube",
      worker: fakeWorker(),
      requestId: "steps",
    });
    await stream.consumeStream();

    const choices = doStream.mock.calls.map(([options]) => options.toolChoice?.type);
    expect(choices).toEqual([...Array(MAX_AGENT_STEPS - 1).fill("auto"), "none"]);
  });

  it.each([
    ["anthropic/claude-sonnet-5", { openrouter: { reasoning: { max_tokens: 2048 } } }],
    ["deepseek/deepseek-v4-flash", undefined],
    ["google/gemini-3-flash-preview", undefined],
  ])("applies the provider options for %s from the model id", async (modelId, expected) => {
    const doStream = scripted([textStep()]);
    const stream = await startedTurn({
      model: new MockLanguageModelV3({ modelId, doStream }),
      prompt: "make a cube",
      worker: fakeWorker(),
      requestId: "provider-options",
    });
    await stream.consumeStream();
    expect(doStream.mock.calls[0][0].providerOptions).toEqual(expected);
    expect(doStream.mock.calls[0][0].maxOutputTokens).toBe(16_000);
  });

  it("streams the STL to the caller but never sends it back to the model", async () => {
    const doStream = scripted([toolStep("c1"), textStep()]);
    const stream = await startedTurn({
      model: new MockLanguageModelV3({ doStream }),
      prompt: "make a cube",
      worker: fakeWorker(),
      requestId: "stl",
    });
    await stream.consumeStream();

    const steps = await stream.steps;
    expect(steps[0].toolResults[0]?.output).toMatchObject({ success: true, stlBase64: STL });
    const secondPrompt = JSON.stringify(doStream.mock.calls[1][0].prompt);
    expect(secondPrompt).toContain("Render OK. Bounding box: 10.0x10.0x10.0mm.");
    expect(secondPrompt).not.toContain(STL);
  });

  it("aborts an in-flight worker call when the caller aborts", async () => {
    const { render, started } = hangingRender();
    const controller = new AbortController();
    const onSettled = vi.fn();
    const stream = await startedTurn({
      model: new MockLanguageModelV3({ doStream: scripted([toolStep("c1")]) }),
      prompt: "make a cube",
      worker: fakeWorker({ render }),
      requestId: "abort",
      abortSignal: controller.signal,
      onSettled,
    });
    const consumed = stream.consumeStream();

    const workerSignal = await started;
    expect(workerSignal?.aborted).toBe(false);
    expect(onSettled).not.toHaveBeenCalled();
    controller.abort();
    expect(workerSignal?.aborted).toBe(true);
    expect(onSettled).toHaveBeenCalledOnce();

    await consumed;
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("aborts the worker call and settles when the turn timeout elapses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { render, started } = hangingRender();
      const onSettled = vi.fn();
      const stream = await startedTurn({
        model: new MockLanguageModelV3({ doStream: scripted([toolStep("c1")]) }),
        prompt: "make a cube",
        worker: fakeWorker({ render }),
        requestId: "timeout",
        onSettled,
      });
      const consumed = stream.consumeStream();

      const workerSignal = await started;
      vi.advanceTimersByTime(AGENT_TURN_TIMEOUT_MS - 1);
      expect(workerSignal?.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(workerSignal?.aborted).toBe(true);
      expect((workerSignal?.reason as DOMException).name).toBe("TimeoutError");

      await consumed;
      expect(onSettled).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still enforces the turn timeout after an error part", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { render, started } = hangingRender();
      const onSettled = vi.fn();
      const stepWithError: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "error", error: new Error("transient provider hiccup") },
        ...toolStep("c1").slice(1),
      ];
      const stream = await startedTurn({
        model: new MockLanguageModelV3({ doStream: scripted([stepWithError]) }),
        prompt: "make a cube",
        worker: fakeWorker({ render }),
        requestId: "timeout-after-error",
        onSettled,
      });
      const consumed = stream.consumeStream();

      const workerSignal = await started;
      expect(errorSpy).toHaveBeenCalled(); // the error part went by
      expect(onSettled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(AGENT_TURN_TIMEOUT_MS);
      expect(workerSignal?.aborted).toBe(true);
      expect(onSettled).toHaveBeenCalledOnce();

      await consumed;
      expect(onSettled).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  describe("onSettled fires exactly once", () => {
    it("when the turn finishes", async () => {
      const onSettled = vi.fn();
      const stream = await startedTurn({
        model: new MockLanguageModelV3({ doStream: scripted([toolStep("c1"), textStep()]) }),
        prompt: "make a cube",
        worker: fakeWorker(),
        requestId: "finish",
        onSettled,
      });
      await stream.consumeStream();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onSettled).toHaveBeenCalledOnce();
    });

    it("when the caller aborts and nobody reads the stream any more, aborting the model call", async () => {
      const controller = new AbortController();
      const onSettled = vi.fn();
      // A model call that never completes on its own.
      const doStream = vi.fn<DoStream>(async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>() }));
      await startedTurn({
        model: new MockLanguageModelV3({ doStream }),
        prompt: "make a cube",
        worker: fakeWorker(),
        requestId: "abort-unread",
        abortSignal: controller.signal,
        onSettled,
      });
      await vi.waitFor(() => expect(doStream).toHaveBeenCalledOnce());
      const modelSignal = doStream.mock.calls[0][0].abortSignal;
      expect(modelSignal?.aborted).toBe(false);
      expect(onSettled).not.toHaveBeenCalled();

      controller.abort();
      controller.abort();
      expect(modelSignal?.aborted).toBe(true);
      expect(onSettled).toHaveBeenCalledOnce();
    });

    it("at the real end of a turn that streams an error part and then recovers", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const onSettled = vi.fn();
        const render = vi.fn<AgentWorker["render"]>(async () => okRender());
        const stepWithError: LanguageModelV3StreamPart[] = [
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("transient provider hiccup") },
          ...toolStep("c1").slice(1),
        ];
        const stream = await startedTurn({
          model: new MockLanguageModelV3({ doStream: scripted([stepWithError, textStep()]) }),
          prompt: "make a cube",
          worker: fakeWorker({ render }),
          requestId: "error-part",
          onSettled,
        });

        const seen: string[] = [];
        for await (const part of stream.fullStream) {
          seen.push(part.type);
          // The error part does not end the turn.
          if (part.type === "error") expect(onSettled).not.toHaveBeenCalled();
        }
        expect(seen).toContain("error");
        expect(render).toHaveBeenCalledOnce(); // the tool call after the error still ran
        expect(seen).toContain("text-delta"); // and the next step still streamed
        expect(onSettled).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledOnce(); // logged once, by the turn
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("when the model stream errors", async () => {
      const onSettled = vi.fn();
      const stream = await startedTurn({
        model: new MockLanguageModelV3({
          doStream: async () => {
            throw new Error("provider exploded");
          },
        }),
        prompt: "make a cube",
        worker: fakeWorker(),
        requestId: "stream-error",
        onSettled,
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const errors: unknown[] = [];
      for await (const part of stream.fullStream) if (part.type === "error") errors.push(part.error);
      vi.mocked(console.error).mockRestore();

      expect(errors).toHaveLength(1);
      expect(onSettled).toHaveBeenCalledOnce();
    });

    it("when the model stream itself errors mid-turn (connection dropped), logging it once", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const onSettled = vi.fn();
        let pulls = 0;
        const doStream = vi.fn<DoStream>(async () => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            pull(controller) {
              if (pulls++ === 0) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: "Half a rep" });
              } else {
                controller.error(new Error("connection dropped"));
              }
            },
          }),
        }));
        const stream = await startedTurn({
          model: new MockLanguageModelV3({ doStream }),
          prompt: "make a cube",
          worker: fakeWorker(),
          requestId: "stream-dropped",
          onSettled,
        });

        const seen: string[] = [];
        await expect(
          (async () => {
            for await (const part of stream.fullStream) seen.push(part.type);
          })(),
        ).rejects.toThrow("connection dropped");

        expect(seen).toContain("text-delta"); // the chunk before the drop went through
        // Ended right away, not by the 120s turn timeout.
        expect(onSettled).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain("[stream-dropped]");
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("when starting the turn throws synchronously, and rethrows", async () => {
      const onSettled = vi.fn();
      const model = new MockLanguageModelV3({ doStream: scripted([]) });
      Object.defineProperty(model, "modelId", {
        get: () => {
          throw new Error("broken model adapter");
        },
      });
      await expect(
        runAgentTurn({ model, prompt: "make a cube", worker: fakeWorker(), requestId: "throw", onSettled }),
      ).rejects.toThrow("broken model adapter");
      expect(onSettled).toHaveBeenCalledOnce();
    });

    it("when the worker ping throws, and rethrows", async () => {
      const onSettled = vi.fn();
      const worker = fakeWorker({
        ping: async () => {
          throw new Error("ping exploded");
        },
      });
      await expect(
        runAgentTurn({ model: new MockLanguageModelV3(), prompt: "x", worker, requestId: "ping-throw", onSettled }),
      ).rejects.toThrow("ping exploded");
      expect(onSettled).toHaveBeenCalledOnce();
    });

    it("when the worker is down, without calling the model", async () => {
      const onSettled = vi.fn();
      const doStream = scripted([toolStep("c1")]);
      const turn = await runAgentTurn({
        model: new MockLanguageModelV3({ doStream }),
        prompt: "make a cube",
        worker: fakeWorker({ ping: async () => false }),
        requestId: "worker-down",
        onSettled,
      });
      expect(turn).toEqual({ ok: false, reason: "worker-unavailable" });
      expect(doStream).not.toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalledOnce();
    });
  });
});

describe("openRouterModel", () => {
  it("builds exactly the requested model id, including ids outside the allowlist", () => {
    const model = openRouterModel("google/gemini-2.5-flash", "test-key");
    expect(model.modelId).toBe("google/gemini-2.5-flash");
    expect(model.provider).toMatch(/^openrouter/);
  });

  it("asks OpenRouter to report usage on streamed responses", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const model = openRouterModel("deepseek/deepseek-v4-flash", "test-key");
      const { stream } = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      await stream.pipeTo(new WritableStream());
      expect(fetchStub).toHaveBeenCalledOnce();
      expect(body?.stream).toBe(true);
      expect(body?.stream_options).toEqual({ include_usage: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to build a model without an API key", () => {
    expect(() => openRouterModel("deepseek/deepseek-v4-flash", undefined)).toThrow(
      "OPENROUTER_API_KEY is not configured",
    );
  });
});

describe("allowedModelId", () => {
  it("keeps an allowlisted model and falls back to the default otherwise", () => {
    expect(allowedModelId(ALLOWED_MODEL_IDS[1])).toBe(ALLOWED_MODEL_IDS[1]);
    expect(allowedModelId("someone/unlisted-model")).toBe(ALLOWED_MODEL_IDS[0]);
    expect(allowedModelId(undefined)).toBe(ALLOWED_MODEL_IDS[0]);
  });
});

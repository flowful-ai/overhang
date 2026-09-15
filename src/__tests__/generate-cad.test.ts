import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createGenerateCadPost } from "@/app/api/generate-cad/handler";
import { AGENT_TURN_TIMEOUT_MS, openRouterModel } from "@/lib/agent-turn";

// The real handler, driven through injected adapters: a mock model and a fake
// CAD worker (no module mocks).
const cadWorkerMock = vi.fn();
const pingMock = vi.fn();
let mockModel: MockLanguageModelV3 | null = null;
const worker = {
  render: (code: string, requestId: string) => cadWorkerMock(code, requestId),
  ping: () => pingMock(),
};
const POST = createGenerateCadPost({
  model: () => {
    if (!mockModel) throw new Error("test did not set a mock model");
    return mockModel;
  },
  worker,
});

beforeEach(() => {
  // Trust the forwarded IP so each request's random x-forwarded-for isolates
  // into its own rate-limit bucket; otherwise every request collapses to the
  // single "anon" bucket and the suite can intermittently 429.
  process.env.TRUST_PROXY = "1";
  cadWorkerMock.mockReset();
  pingMock.mockReset();
  pingMock.mockResolvedValue(true); // worker reachable by default
  mockModel = null;
});

afterAll(() => {
  delete process.env.TRUST_PROXY;
});

interface ScriptedToolCall {
  toolCallId: string;
  code: string;
}

const FINISH_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

/**
 * Returns one scripted stream per call. Each step emits a single tool call.
 * Steps after the last script are required when stopWhen lets the loop run
 * past the configured retries; we emit a "stop" finish to terminate.
 */
function scriptedDoStream(steps: ScriptedToolCall[]) {
  let i = 0;
  return async () => {
    const step = steps[i++];
    if (!step) {
      // Loop ran further than scripted — emit an empty stop so the SDK exits.
      const stopChunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: FINISH_USAGE },
      ];
      return { stream: simulateReadableStream({ chunks: stopChunks }) };
    }
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: step.toolCallId, toolName: "runCadquery" },
      { type: "tool-input-delta", id: step.toolCallId, delta: JSON.stringify({ code: step.code }) },
      { type: "tool-input-end", id: step.toolCallId },
      {
        type: "tool-call",
        toolCallId: step.toolCallId,
        toolName: "runCadquery",
        input: JSON.stringify({ code: step.code }),
      },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: FINISH_USAGE },
    ];
    return { stream: simulateReadableStream({ chunks }) };
  };
}

function makeRequest(body: object = { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "make a cube" }] }] }): Request {
  return new Request("http://localhost/api/generate-cad", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `1.2.3.${Math.floor(Math.random() * 254) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

async function readSseStream(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf;
}

describe("generate-cad route — agentic tool loop", () => {
  it("happy path: one tool call → render success", async () => {
    cadWorkerMock.mockResolvedValue({
      stl_base64: "STLBASE64",
      warnings: [],
      metrics: { bbox: { x: 10, y: 10, z: 10 }, volume: 1000 },
    });

    mockModel = new MockLanguageModelV3({
      doStream: scriptedDoStream([
        { toolCallId: "call-1", code: "import cadquery as cq\nresult = cq.Workplane().box(10,10,10)" },
      ]),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await readSseStream(res);
    expect(body).toContain("runCadquery");
    expect(body).toContain("STLBASE64");
    expect(cadWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("agentic retry: worker fails → model calls runCadquery again", async () => {
    cadWorkerMock
      .mockRejectedValueOnce(new Error("CAD Rendering Failed: NameError"))
      .mockResolvedValueOnce({
        stl_base64: "FIXED_STL",
        warnings: ["thin wall: 0.8mm"],
        metrics: { bbox: { x: 5, y: 5, z: 5 }, volume: 125 },
      });

    mockModel = new MockLanguageModelV3({
      doStream: scriptedDoStream([
        { toolCallId: "c1", code: "broken = ?" },
        { toolCallId: "c2", code: "import cadquery as cq\nresult = cq.Workplane().box(5,5,5)" },
      ]),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await readSseStream(res);
    expect(cadWorkerMock).toHaveBeenCalledTimes(2);
    expect(body).toContain("FIXED_STL");
    expect(body).toContain("thin wall");
  });

  it("rejects empty messages with 400 (zod validation)", async () => {
    mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
    const res = await POST(makeRequest({ messages: [] }));
    expect(res.status).toBe(400);
    expect(cadWorkerMock).not.toHaveBeenCalled();
  });

  it("rejects missing messages with 400", async () => {
    mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 503 when EMERGENCY_DISABLE_GENERATION=1 (kill switch)", async () => {
    process.env.EMERGENCY_DISABLE_GENERATION = "1";
    try {
      mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
      const res = await POST(makeRequest());
      expect(res.status).toBe(503);
      expect(cadWorkerMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.EMERGENCY_DISABLE_GENERATION;
    }
  });

  it("returns 413 when request body exceeds 10MB", async () => {
    mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
    const req = new Request("http://localhost/api/generate-cad", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(11 * 1024 * 1024),
        "x-forwarded-for": `1.2.3.${Math.floor(Math.random() * 254) + 1}`,
      },
      body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "x" }] }] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(cadWorkerMock).not.toHaveBeenCalled();
  });

  it("includes bounding box in tool success summary (model self-check signal)", async () => {
    cadWorkerMock.mockResolvedValue({
      stl_base64: "STLBASE64",
      warnings: [],
      metrics: { bbox: { x: 50, y: 30, z: 10 }, volume: 15000 },
    });

    mockModel = new MockLanguageModelV3({
      doStream: scriptedDoStream([
        { toolCallId: "call-1", code: "import cadquery as cq\nresult = cq.Workplane().box(50,30,10)" },
      ]),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await readSseStream(res);
    expect(body).toMatch(/Bounding box:.*50\.0x30\.0x10\.0mm/);
  });

  it("returns 503 WITHOUT opening the LLM stream when the CAD worker is down", async () => {
    // A worker outage must short-circuit before streamText: otherwise the agent
    // burns up to MAX_AGENT_STEPS LLM calls retrying a render that can't succeed.
    pingMock.mockResolvedValue(false);
    const doStreamSpy = vi.fn(
      scriptedDoStream([{ toolCallId: "c1", code: "import cadquery as cq\nresult = cq.Workplane().box(1,1,1)" }]),
    );
    mockModel = new MockLanguageModelV3({ doStream: doStreamSpy });

    const res = await POST(makeRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "The CAD engine is temporarily unavailable. Please try again in a moment.",
    });
    expect(doStreamSpy).not.toHaveBeenCalled(); // no LLM tokens spent
    expect(cadWorkerMock).not.toHaveBeenCalled();
  });

  it("drives a self-correcting turn through multiple renders in a single request", async () => {
    // A turn can render several times while the agent fixes its own mistakes;
    // the request should still complete once with a 200 stream.
    cadWorkerMock.mockResolvedValue({
      stl_base64: "STLBASE64",
      warnings: [],
      metrics: { bbox: { x: 10, y: 10, z: 10 }, volume: 1000 },
    });

    mockModel = new MockLanguageModelV3({
      doStream: scriptedDoStream([
        { toolCallId: "c1", code: "import cadquery as cq\nresult = cq.Workplane().box(10,10,10)" },
        { toolCallId: "c2", code: "import cadquery as cq\nresult = cq.Workplane().box(12,12,12)" },
      ]),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    await readSseStream(res); // drive the stream to onFinish

    expect(cadWorkerMock).toHaveBeenCalledTimes(2);
  });
  it("returns {error} JSON and frees the slot when the model cannot be built (no API key)", async () => {
    // Sized through the pre-rename ANON_* name: the fallback must still cap the pool.
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "");
    vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "1");
    try {
      const noKey = createGenerateCadPost({ model: (id) => openRouterModel(id ?? "any/model", undefined), worker });
      const res = await noKey(makeRequest());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "OPENROUTER_API_KEY is not configured" });

      // The only slot was released: the next turn is not refused.
      mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
      const next = await POST(makeRequest());
      expect(next.status).toBe(200);
      await readSseStream(next);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("frees the slot as soon as the client disconnects (req.signal aborts), without reading the stream", async () => {
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "1");
    try {
      // A model that never finishes, so only the abort can end the turn.
      mockModel = new MockLanguageModelV3({
        doStream: async () => ({ stream: new ReadableStream<LanguageModelV3StreamPart>() }),
      });
      const client = new AbortController();
      const req = new Request("http://localhost/api/generate-cad", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `1.2.4.${Math.floor(Math.random() * 254) + 1}` },
        body: JSON.stringify({ messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "make a cube" }] }] }),
        signal: client.signal,
      });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect((await POST(makeRequest())).status).toBe(503); // slot held by the hanging turn

      client.abort();
      mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
      const next = await POST(makeRequest());
      expect(next.status).toBe(200);
      await readSseStream(next);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("streams the turn timeout as an error, not a clean finish, and frees the slot", async () => {
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A model that never finishes on its own and, like a real provider
      // fetch, fails once its abort signal fires: only the turn timeout ends it.
      mockModel = new MockLanguageModelV3({
        doStream: async ({ abortSignal }) => ({
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), { once: true });
            },
          }),
        }),
      });
      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      const body = readSseStream(res);
      await vi.advanceTimersByTimeAsync(AGENT_TURN_TIMEOUT_MS);
      const text = await body;

      // The SDK ends this stream with an "abort" chunk (a clean finish for the
      // client); the handler must turn it into an error.
      expect(text).toContain('"type":"error","errorText":"The operation was aborted due to timeout"');
      expect(text).not.toContain('"type":"abort"');

      vi.useRealTimers();
      mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
      const next = await POST(makeRequest());
      expect(next.status).toBe(200);
      await readSseStream(next);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("streams a sanitized error and frees the slot when the model call fails", async () => {
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "1");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockModel = new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("upstream failed at /opt/conda/lib/python3.11/site.py");
        },
      });
      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
      const body = await readSseStream(res);
      expect(body).toContain('"errorText":"upstream failed at <path>"');
      // Logged exactly once for the whole request (by the turn, not again by the handler).
      expect(errorSpy).toHaveBeenCalledOnce();

      mockModel = new MockLanguageModelV3({ doStream: scriptedDoStream([]) });
      const next = await POST(makeRequest());
      expect(next.status).toBe(200);
      await readSseStream(next);
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

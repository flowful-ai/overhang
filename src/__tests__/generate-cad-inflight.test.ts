import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

// Generation is free (no quota) and anonymous, so the guard left is the shared
// generation pool: MAX_CONCURRENT_GENERATIONS turns at once across all callers
// (ANON_MAX_CONCURRENT_GENERATIONS still read as a fallback), 503 over it.

beforeEach(() => {
  // Fresh modules per test, so the process-wide pool starts empty.
  vi.resetModules();
  vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "");
  vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(): Request {
  return new Request("http://localhost/api/generate-cad", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `2.2.2.${Math.floor(Math.random() * 254) + 1}`,
    },
    body: JSON.stringify({
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "make a cube" }] }],
    }),
  });
}

const STOP_CHUNKS: LanguageModelV3StreamPart[] = [
  { type: "stream-start", warnings: [] },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  },
];

const stopModel = () =>
  new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: STOP_CHUNKS }) }) });

// Imported per test (vi.resetModules runs before each test).
async function loadPost(ping: () => Promise<boolean> = async () => true) {
  const { createGenerateCadPost } = await import("@/app/api/generate-cad/handler");
  return createGenerateCadPost({ model: stopModel, worker: { render: vi.fn(), ping } });
}

describe("/api/generate-cad generation pool", () => {
  it.each([["MAX_CONCURRENT_GENERATIONS"], ["ANON_MAX_CONCURRENT_GENERATIONS"]])(
    "refuses a turn over the pool sized by %s with the busy 503",
    async (envName) => {
      vi.stubEnv(envName, "1");
      const POST = await loadPost();

      // First request acquires the only slot and returns a streaming response
      // we deliberately leave unconsumed, so the slot stays held.
      const res1 = await POST(makeRequest());
      expect(res1.status).toBe(200);

      // A different caller (different IP) still draws from the same global pool.
      const res2 = await POST(makeRequest());
      expect(res2.status).toBe(503);
      expect(await res2.json()).toEqual({ error: "Overhang is busy right now. Please try again in a moment." });

      // Cleanup only. Cancelling the response body does not end the turn by
      // itself (in production a client disconnect aborts req.signal, which
      // does; see generate-cad.test.ts). This slot is freed by the turn
      // timeout, and it cannot leak into other tests: each test loads fresh
      // modules.
      await res1.body?.cancel();
    },
  );

  it("releases the slot when the worker is down, so the next request isn't locked out", async () => {
    // The worker-down path acquires the slot, then returns 503. It MUST release
    // the slot: otherwise a single worker blip locks everyone out until the
    // safety timer. First request: worker down -> 503. Second: worker back ->
    // 200, NOT the busy 503, proving the slot was freed.
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "1");
    const ping = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const POST = await loadPost(ping);

    const res1 = await POST(makeRequest());
    expect(res1.status).toBe(503);
    expect(await res1.json()).toEqual({
      error: "The CAD engine is temporarily unavailable. Please try again in a moment.",
    });

    const res2 = await POST(makeRequest());
    expect(res2.status).toBe(200);
    await res2.body?.cancel();
  });
});

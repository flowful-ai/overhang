import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const renderMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cad-render", () => ({ renderCad: renderMock }));
vi.mock("@/lib/cad-worker", () => ({ httpStatusForWorkerFailure: () => 500 }));

import { POST } from "@/app/api/render-cad/route";
import { RENDER_POOL, acquirePoolSlot, releasePoolSlot } from "@/lib/in-flight";

// render-cad calls share a global concurrency pool sized by
// MAX_CONCURRENT_RENDERS (ANON_MAX_CONCURRENT_RENDERS as the fallback).

const makeRequest = () =>
  new Request("http://localhost/api/render-cad", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "import cadquery as cq\nresult = cq.Workplane().box(1,1,1)" }),
  });

const OK_RENDER = {
  success: true,
  code: "x",
  stlBase64: "STL",
  metrics: { bbox: { x: 1, y: 1, z: 1 }, volume: 1 },
  warnings: [],
};

beforeEach(() => {
  vi.stubEnv("MAX_CONCURRENT_RENDERS", "");
  vi.stubEnv("ANON_MAX_CONCURRENT_RENDERS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  renderMock.mockReset();
});

describe("/api/render-cad concurrency pool", () => {
  it.each([["MAX_CONCURRENT_RENDERS"], ["ANON_MAX_CONCURRENT_RENDERS"]])(
    "returns the busy 503 when the pool sized by %s is full",
    async (envName) => {
      vi.stubEnv(envName, "2");
      const held = [acquirePoolSlot(RENDER_POOL, 2)!, acquirePoolSlot(RENDER_POOL, 2)!];
      try {
        const res = await POST(makeRequest());
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "Overhang is busy right now. Please try again in a moment." });
        expect(renderMock).not.toHaveBeenCalled();
      } finally {
        held.forEach((t) => releasePoolSlot(RENDER_POOL, t));
      }
    },
  );

  it("frees the slot after the render, on success and on a throw", async () => {
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "1");
    renderMock.mockResolvedValueOnce(OK_RENDER);
    expect((await POST(makeRequest())).status).toBe(200);

    renderMock.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(makeRequest())).status).toBe(500);

    // Pool of 1 is free again.
    const token = acquirePoolSlot(RENDER_POOL, 1);
    expect(token).not.toBeNull();
    releasePoolSlot(RENDER_POOL, token!);
  });
});

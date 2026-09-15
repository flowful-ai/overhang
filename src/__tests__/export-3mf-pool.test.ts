import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const exportMock = vi.hoisted(() => vi.fn());
const renderMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cad-worker", () => ({ exportThreeMF: exportMock, httpStatusForWorkerFailure: () => 500 }));
vi.mock("@/lib/cad-render", () => ({ renderCad: renderMock }));

import { POST } from "@/app/api/export-3mf/route";
import { POST as renderPOST } from "@/app/api/render-cad/route";
import { RENDER_POOL, acquirePoolSlot, releasePoolSlot } from "@/lib/in-flight";

// export-3mf runs the script on the worker, so it shares the render pool with
// render-cad.

const makeRequest = (path = "/api/export-3mf") =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "import cadquery as cq\nresult = cq.Workplane().box(1,1,1)" }),
  });

beforeEach(() => {
  vi.stubEnv("MAX_CONCURRENT_RENDERS", "");
  vi.stubEnv("ANON_MAX_CONCURRENT_RENDERS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  exportMock.mockReset();
  renderMock.mockReset();
});

describe("/api/export-3mf concurrency pool", () => {
  it.each([["MAX_CONCURRENT_RENDERS"], ["ANON_MAX_CONCURRENT_RENDERS"]])(
    "returns the busy 503 when the render pool sized by %s is full",
    async (envName) => {
      vi.stubEnv(envName, "1");
      const held = acquirePoolSlot(RENDER_POOL, 1)!;
      try {
        const res = await POST(makeRequest());
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "Overhang is busy right now. Please try again in a moment." });
        expect(exportMock).not.toHaveBeenCalled();
      } finally {
        releasePoolSlot(RENDER_POOL, held);
      }
    },
  );

  it("shares the pool with render-cad: an in-flight render blocks an export", async () => {
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "1");
    let finishRender!: (v: unknown) => void;
    renderMock.mockReturnValueOnce(new Promise((resolve) => { finishRender = resolve; }));
    const pendingRender = renderPOST(makeRequest("/api/render-cad"));
    // Let the render route get past body parsing and take the slot.
    await vi.waitFor(() => expect(renderMock).toHaveBeenCalled());

    const blocked = await POST(makeRequest());
    expect(blocked.status).toBe(503);
    expect(exportMock).not.toHaveBeenCalled();

    finishRender({ success: true, code: "x", stlBase64: "STL", metrics: {}, warnings: [] });
    expect((await pendingRender).status).toBe(200);

    exportMock.mockResolvedValueOnce({ threemf_base64: "3MF" });
    expect((await POST(makeRequest())).status).toBe(200);
  });

  it("exports and frees the slot afterwards, also when the worker throws", async () => {
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "1");
    exportMock.mockResolvedValueOnce({ threemf_base64: "3MF" });
    const ok = await POST(makeRequest());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ threemfBase64: "3MF" });

    exportMock.mockRejectedValueOnce(new Error("worker down"));
    expect((await POST(makeRequest())).status).toBe(500);

    const token = acquirePoolSlot(RENDER_POOL, 1);
    expect(token).not.toBeNull();
    releasePoolSlot(RENDER_POOL, token!);
  });
});

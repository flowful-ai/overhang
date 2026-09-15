import { describe, it, expect, vi } from "vitest";
import { renderCad } from "@/lib/cad-render";
import type { WorkerRenderResult } from "@/lib/cad-worker-protocol";

const okWorker = (over: Partial<WorkerRenderResult> = {}): WorkerRenderResult => ({
  stl_base64: "STL",
  metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
  warnings: null,
  console_output: null,
  ...over,
});

describe("renderCad", () => {
  it("normalizes typographic punctuation before calling the worker", async () => {
    // This is the whole point: the manual /api/render-cad path used to skip
    // this, so a pasted em-dash SyntaxError'd there but healed via the agent.
    const callWorker = vi.fn(async (_code: string, _requestId: string) => okWorker());
    await renderCad("x = 1  # 2–12 mm width", "req-1", { callWorker });
    const sentCode = callWorker.mock.calls[0][0];
    expect(sentCode).not.toMatch(/[‒–—‘’“”]/);
    expect(sentCode).toContain("2-12 mm width");
  });

  it("returns a structured success result with coalesced warnings and normalized code", async () => {
    const callWorker = vi.fn(async () => okWorker({ warnings: ["thin wall"] }));
    const r = await renderCad("code — here", "req-2", { callWorker });
    expect(r).toEqual({
      success: true,
      code: "code - here",
      stlBase64: "STL",
      warnings: ["thin wall"],
      metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
    });
  });

  it("coalesces null warnings to an empty array", async () => {
    const callWorker = vi.fn(async () => okWorker({ warnings: null }));
    const r = await renderCad("code", "req-3", { callWorker });
    expect(r.success && r.warnings).toEqual([]);
  });

  it("returns a sanitized failure result (with the normalized code) when the worker throws", async () => {
    const callWorker = vi.fn(async () => {
      throw new Error("CAD Rendering Failed: NameError at /srv/app/worker.py:5");
    });
    const r = await renderCad("bad — code", "req-4", { callWorker });
    expect(r.success).toBe(false);
    expect(r).toMatchObject({ success: false, code: "bad - code" });
    // sanitize-error strips filesystem paths from the message
    expect(r.success === false && r.error).not.toContain("/srv/app");
  });
});

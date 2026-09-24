import { describe, it, expect, vi } from "vitest";
import { renderCad } from "@/lib/cad-render";
import { createRunCadqueryTool, WORKER_BUSY_ERROR } from "@/lib/cad-agent";
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

  describe("worker busy (503)", () => {
    const busy = () => Object.assign(new Error("CAD Rendering Failed: Worker is busy"), { workerStatus: 503 });
    const NO_WAIT = [0, 0];

    it("retries a 503 and returns the render once the worker frees up", async () => {
      const callWorker = vi
        .fn(async (): Promise<WorkerRenderResult> => okWorker())
        .mockRejectedValueOnce(busy())
        .mockRejectedValueOnce(busy());
      const r = await renderCad("code", "req-5", { callWorker, busyRetryDelaysMs: NO_WAIT });
      expect(r.success).toBe(true);
      expect(callWorker).toHaveBeenCalledTimes(3);
    });

    it("gives up after the retries with the worker's own message and status (what /api/render-cad shows)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const callWorker = vi.fn(async (): Promise<WorkerRenderResult> => {
        throw busy();
      });
      const r = await renderCad("code", "req-6", { callWorker, busyRetryDelaysMs: NO_WAIT });
      warn.mockRestore();
      expect(callWorker).toHaveBeenCalledTimes(3);
      expect(r).toEqual({
        success: false,
        code: "code",
        error: "CAD Rendering Failed: Worker is busy",
        workerStatus: 503,
      });
    });

    it("tells the model (runCadquery tool) the failure is transient, not a code problem", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const worker = vi.fn(async (): Promise<WorkerRenderResult> => {
          throw busy();
        });
        const runCadquery = createRunCadqueryTool({ requestId: "req-9", worker });
        const pending = runCadquery.execute!({ code: "code" }, { toolCallId: "c1", messages: [] });
        await vi.runAllTimersAsync();
        expect(await pending).toEqual({ success: false, code: "code", error: WORKER_BUSY_ERROR });
        expect(worker).toHaveBeenCalledTimes(3);
        expect(WORKER_BUSY_ERROR).toMatch(/Resend the same code unchanged/);
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it("stops retrying once the caller aborts", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const controller = new AbortController();
      const callWorker = vi.fn(async (): Promise<WorkerRenderResult> => {
        controller.abort();
        throw busy();
      });
      const r = await renderCad("code", "req-7", {
        callWorker,
        signal: controller.signal,
        busyRetryDelaysMs: [60_000, 60_000],
      });
      warn.mockRestore();
      expect(callWorker).toHaveBeenCalledOnce();
      expect(r.success).toBe(false);
    });

    it("does not retry a code failure (400)", async () => {
      const callWorker = vi.fn(async (): Promise<WorkerRenderResult> => {
        throw Object.assign(new Error("CAD Rendering Failed: NameError"), { workerStatus: 400 });
      });
      const r = await renderCad("code", "req-8", { callWorker, busyRetryDelaysMs: NO_WAIT });
      expect(callWorker).toHaveBeenCalledOnce();
      expect(r).toMatchObject({ success: false, workerStatus: 400 });
    });
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { callCadWorker, exportThreeMF, pingCadWorker } from "@/lib/cad-worker";
import { APP_CONSTANTS } from "@/lib/utils";
import { REQUEST_ID_HEADER } from "@/lib/sanitize-error";

// Wire-seam behavior of the cad-worker HTTP client. The protocol *schema*
// parsing is covered in cad-worker-protocol.test.ts; this file pins the
// error handling and request contract of callWorker(), which is what carries
// worker failures back into the agentic loop.

const okRenderPayload = {
  stl_base64: "STL",
  metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
  warnings: null,
  console_output: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callCadWorker error handling", () => {
  it("surfaces the worker's `detail` field from a non-2xx JSON body", async () => {
    // This is the exact path that returns a Python-side render error to the
    // model so it can fix the script on the next step.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "Line 3: NameError: name 'x' is not defined" }), {
            status: 400,
          }),
      ),
    );
    await expect(callCadWorker("x", "req-err")).rejects.toThrow(
      /CAD Rendering Failed: Line 3: NameError/,
    );
  });

  it("falls back to raw text when a non-2xx body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream 502 bad gateway", { status: 502 })),
    );
    await expect(callCadWorker("x", "req-raw")).rejects.toThrow(
      /CAD Rendering Failed: upstream 502 bad gateway/,
    );
  });

  it("maps an aborted request (timeout) to a clear timeout error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    await expect(callCadWorker("x", "req-timeout")).rejects.toThrow(/CAD worker timed out/);
  });

  it("cancels the fetch when the caller's signal aborts, reported as an abort rather than a timeout", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            fetchSignal = init.signal ?? undefined;
            fetchSignal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );
    const caller = new AbortController();
    const pending = callCadWorker("x", "req-cancel", { signal: caller.signal });
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    expect(fetchSignal?.aborted).toBe(false);

    caller.abort();
    expect(fetchSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow("CAD worker request aborted");
  });

  it("maps a connection failure to a friendly 'is it running?' error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(callCadWorker("x", "req-conn")).rejects.toThrow(
      /Failed to connect to CAD worker/,
    );
  });

  it("rejects over-length code before hitting the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tooLong = "x".repeat(APP_CONSTANTS.MAX_CODE_LENGTH + 1);
    await expect(callCadWorker(tooLong, "req-long")).rejects.toThrow(/maximum length/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("callCadWorker request contract", () => {
  it("sends the request id header and omits the worker secret when none is configured", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedInit = init;
        return new Response(JSON.stringify(okRenderPayload), { status: 200 });
      }),
    );
    await callCadWorker("import cadquery as cq\nresult = None", "req-headers");

    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers[REQUEST_ID_HEADER]).toBe("req-headers");
    // WORKER_SECRET is unset in the test env, so the header must be absent
    // (dropped, not sent empty) — the worker's no-secret branch relies on this.
    expect(headers["X-Worker-Secret"]).toBeUndefined();
    // Body carries the code, not the request id.
    expect(JSON.parse(capturedInit!.body as string)).toEqual({
      code: "import cadquery as cq\nresult = None",
    });
  });
});

describe("exportThreeMF", () => {
  it("returns the parsed 3MF payload on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ threemf_base64: "PK-DATA", console_output: null }), {
            status: 200,
          }),
      ),
    );
    const out = await exportThreeMF("x", "req-3mf");
    expect(out.threemf_base64).toBe("PK-DATA");
  });

  it("throws on a malformed 3MF response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ wrong: true }), { status: 200 })),
    );
    await expect(exportThreeMF("x", "req-3mf-bad")).rejects.toThrow(
      /unexpected response shape/i,
    );
  });
});

describe("pingCadWorker", () => {
  it("returns true when the worker answers OK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    expect(await pingCadWorker()).toBe(true);
  });

  it("returns false on a non-OK status without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    expect(await pingCadWorker()).toBe(false);
  });

  it("returns false (never throws) when the fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await pingCadWorker()).toBe(false);
  });
});

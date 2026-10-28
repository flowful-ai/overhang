import { describe, it, expect, afterEach, vi } from "vitest";
import {
  WorkerRenderResult,
  WorkerThreeMFResult,
  CadqueryToolResult,
} from "@/lib/cad-worker-protocol";
import { callCadWorker } from "@/lib/cad-worker";

describe("WorkerRenderResult (wire schema)", () => {
  const valid = {
    stl_base64: "STLBASE64",
    metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
    warnings: null,
    console_output: null,
  };

  it("parses a valid worker payload (warnings=null)", () => {
    expect(WorkerRenderResult.parse(valid)).toEqual(valid);
  });

  it("parses a payload with a non-empty warnings list", () => {
    expect(() =>
      WorkerRenderResult.parse({ ...valid, warnings: ["thin wall"] }),
    ).not.toThrow();
  });

  it("rejects an unknown field (strict catches Python-side drift)", () => {
    expect(() =>
      WorkerRenderResult.parse({ ...valid, surprise: "drift" }),
    ).toThrow();
  });

  it("rejects a missing metrics object", () => {
    const { metrics: _m, ...rest } = valid;
    expect(() => WorkerRenderResult.parse(rest)).toThrow();
  });

  it("rejects a malformed bbox (missing axis)", () => {
    expect(() =>
      WorkerRenderResult.parse({
        ...valid,
        metrics: { bbox: { x: 1, y: 2 }, volume: 6 },
      }),
    ).toThrow();
  });

  it("parses issues, the geometry report and views (as the worker emits them)", () => {
    const full = {
      ...valid,
      warnings: ["Not on the build plate"],
      issues: [{ severity: "advisory", message: "Not on the build plate" }],
      geometry: {
        solid_count: 1,
        z_min: -2.5,
        bounds_min: [-30, -20, -2.5],
        bounds_max: [30, 20, 2.5],
        valid: true,
        faces: { plane: 6, cylinder: 8 },
        holes: [{ diameter: 3.5, depth: 5, axis: "Z", through: true, count: 4 }],
        hole_count: 4,
        min_wall_mm: 3.48,
        overhang: null,
        solids: [{ volume: 11768.95, bbox: { x: 60, y: 40, z: 5 }, z_min: -2.5 }],
      },
      views: [{ name: "iso", png_base64: "PNG" }],
    };
    expect(WorkerRenderResult.parse(full)).toEqual(full);
    // A worker that has no geometry measurement sends nulls.
    expect(() =>
      WorkerRenderResult.parse({ ...full, geometry: { ...full.geometry, hole_count: null, z_min: null }, views: null }),
    ).not.toThrow();
  });

  it("rejects an unknown issue severity", () => {
    expect(() =>
      WorkerRenderResult.parse({ ...valid, issues: [{ severity: "severe", message: "x" }] }),
    ).toThrow();
  });

  it("rejects warnings that is neither null nor string[]", () => {
    expect(() =>
      WorkerRenderResult.parse({ ...valid, warnings: "not a list" }),
    ).toThrow();
  });
});

describe("WorkerThreeMFResult (wire schema)", () => {
  it("parses a valid 3MF payload", () => {
    expect(() =>
      WorkerThreeMFResult.parse({ threemf_base64: "xyz", console_output: null }),
    ).not.toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      WorkerThreeMFResult.parse({
        threemf_base64: "xyz",
        console_output: null,
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects a missing required field", () => {
    expect(() =>
      WorkerThreeMFResult.parse({ console_output: null }),
    ).toThrow();
  });
});

describe("CadqueryToolResult (tool-result schema)", () => {
  const success = {
    success: true as const,
    code: "import cadquery as cq",
    stlBase64: "STL",
    warnings: [],
    metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
    summary: "Render OK.",
  };

  it("parses the success branch", () => {
    expect(CadqueryToolResult.parse(success)).toEqual(success);
  });

  it("parses the failure branch", () => {
    const fail = { success: false as const, code: "broken", error: "NameError" };
    expect(CadqueryToolResult.parse(fail)).toEqual(fail);
  });

  it("rejects a success result missing stlBase64", () => {
    const { stlBase64: _omit, ...rest } = success;
    expect(() => CadqueryToolResult.parse(rest)).toThrow();
  });

  it("rejects a failure result missing error", () => {
    expect(() =>
      CadqueryToolResult.parse({ success: false, code: "broken" }),
    ).toThrow();
  });

  it("rejects a result with an unknown success value", () => {
    expect(() =>
      CadqueryToolResult.parse({ success: "maybe", code: "x" }),
    ).toThrow();
  });
});

describe("callCadWorker (wire seam)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed payload on a well-formed response", async () => {
    const payload = {
      stl_base64: "STLBASE64",
      metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
      warnings: null,
      console_output: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    );
    const out = await callCadWorker("import cq\nresult = None", "req-1");
    expect(out).toEqual(payload);
  });

  it("throws a useful error when the worker returns a malformed shape", async () => {
    // bbox is missing the z axis - drift simulation.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              stl_base64: "X",
              metrics: { bbox: { x: 1, y: 2 }, volume: 1 },
              warnings: null,
              console_output: null,
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(callCadWorker("x", "req-2")).rejects.toThrow(
      /unexpected response shape/i,
    );
  });

  it("throws when the worker leaks an unknown field (strict)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              stl_base64: "X",
              metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 1 },
              warnings: null,
              console_output: null,
              surprise_new_field: true,
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(callCadWorker("x", "req-3")).rejects.toThrow(
      /unexpected response shape/i,
    );
  });
});

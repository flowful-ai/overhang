import { describe, it, expect, vi } from "vitest";
import { SYSTEM_PROMPT, createRunCadqueryTool, describeGeometry, renderSummary } from "@/lib/cad-agent";
import type { GeometryReport, WorkerRenderResult } from "@/lib/cad-worker-protocol";
import type { RenderWorker } from "@/lib/cad-render";

// The final text-only step itself is tested at the agent turn interface
// (agent-turn.test.ts).

describe("SYSTEM_PROMPT", () => {
  it("points the model at the latest successful tool RESULT code, which carries user edits", () => {
    // next-turn.ts writes the user's edited script into the tool result's
    // `code` field, not into the tool call input.
    expect(SYSTEM_PROMPT).toMatch(/`code` field of the most recent successful `runCadquery` tool RESULT/);
    expect(SYSTEM_PROMPT).not.toMatch(/last `runCadquery` tool call in the conversation contains/);
  });

  it("tells the model the final step has tools disabled", () => {
    expect(SYSTEM_PROMPT).toContain(`last step has tools disabled`);
  });

  it("asks for a plan before the first render and a check against it after each success", () => {
    expect(SYSTEM_PROMPT).toContain("## Plan, then verify");
    expect(SYSTEM_PROMPT).toMatch(/Before your first `runCadquery` call, write a short plan/);
    expect(SYSTEM_PROMPT).toMatch(/Key dimensions/);
    expect(SYSTEM_PROMPT).toMatch(/Interfaces and fit features/);
    expect(SYSTEM_PROMPT).toMatch(/Print orientation: which face sits on the bed/);
    expect(SYSTEM_PROMPT).toMatch(/After each successful render, compare the result with your plan/);
  });

  it("splits issues into blocking and advisory instead of 'fix when severe'", () => {
    expect(SYSTEM_PROMPT).toMatch(/BLOCKING .*fix every one before you finish/);
    expect(SYSTEM_PROMPT).toMatch(/Advisory .*fix it when it contradicts the request/);
    expect(SYSTEM_PROMPT).not.toMatch(/when severe/);
  });
});

const GEOMETRY: GeometryReport = {
  solid_count: 1,
  z_min: 0,
  bounds_min: [-30, -20, 0],
  bounds_max: [30, 20, 5],
  valid: true,
  faces: { plane: 6, cylinder: 4 },
  holes: [{ diameter: 3.5, depth: 5, axis: "Z", through: true, count: 4 }],
  hole_count: 4,
  min_wall_mm: 3.48,
  overhang: { worst_deg: 90, at: [1, 2, 3.25], area_mm2: 40 },
  solids: [],
};

describe("describeGeometry", () => {
  it("states solids, bed contact, holes, faces, walls and the worst overhang", () => {
    expect(describeGeometry(GEOMETRY)).toBe(
      "Geometry: 1 solid; lowest point z=0mm; 4 round holes: 4x d3.5 through along Z; faces: 6 plane, 4 cylinder; " +
        "thinnest wall ~3.48mm; steepest overhang 90 deg from vertical at (1, 2, 3.25).",
    );
  });

  it("says when holes were not measured and when the BRep is invalid", () => {
    const g = { ...GEOMETRY, hole_count: null, holes: [], valid: false, overhang: null, solid_count: 2 };
    const text = describeGeometry(g);
    expect(text).toContain("2 separate solids");
    expect(text).toContain("holes: not measured");
    expect(text).toContain("BRep INVALID");
  });

  it("describes blind holes with their depth", () => {
    const g = { ...GEOMETRY, holes: [{ diameter: 4, depth: 6, axis: "X", through: false, count: 2 }], hole_count: 2 };
    expect(describeGeometry(g)).toContain("2x d4 blind 6mm deep along X");
  });
});

describe("renderSummary", () => {
  const bbox = { x: 60, y: 40, z: 5 };

  it("groups issues by severity", () => {
    const summary = renderSummary({
      bbox,
      warnings: ["Non-watertight mesh", "Overhang warning"],
      issues: [
        { severity: "blocking", message: "Non-watertight mesh" },
        { severity: "advisory", message: "Overhang warning" },
      ],
      geometry: GEOMETRY,
    });
    expect(summary).toMatch(/^Render OK\. Bounding box: 60\.0x40\.0x5\.0mm\. Geometry: 1 solid;/);
    expect(summary).toContain("BLOCKING issues (fix before finishing): Non-watertight mesh");
    expect(summary).toContain("Advisory: Overhang warning");
  });

  it("falls back to unclassified warnings from older workers", () => {
    const summary = renderSummary({ bbox, warnings: ["thin wall"], issues: [] });
    expect(summary).toBe("Render OK. Bounding box: 60.0x40.0x5.0mm. Design review: thin wall");
  });

  it("says when there is nothing to fix", () => {
    expect(renderSummary({ bbox, warnings: [], issues: [] })).toBe("Render OK. Bounding box: 60.0x40.0x5.0mm. No issues.");
  });
});

describe("runCadquery tool", () => {
  const response: WorkerRenderResult = {
    stl_base64: "STL",
    metrics: { bbox: { x: 60, y: 40, z: 5 }, volume: 100 },
    warnings: ["Overhang warning"],
    issues: [{ severity: "advisory", message: "Overhang warning" }],
    geometry: GEOMETRY,
    views: [{ name: "iso", png_base64: "PNG" }],
    console_output: null,
  };

  it("hands views to onViews by tool call and keeps them out of the result", async () => {
    const worker = vi.fn<RenderWorker>(async () => response);
    const onViews = vi.fn();
    const onRender = vi.fn();
    const tool = createRunCadqueryTool({ requestId: "r", worker, onViews, onRender });
    const out = await tool.execute!({ code: "code" }, { toolCallId: "call-7", messages: [] });
    expect(worker.mock.calls[0]).toEqual(["code", "r", expect.objectContaining({ views: true })]);
    expect(onViews).toHaveBeenCalledWith("call-7", response.views);
    expect(JSON.stringify(out)).not.toContain("PNG");
    expect(out).toMatchObject({ success: true, issues: response.issues, geometry: GEOMETRY });
    expect(onRender).toHaveBeenCalledWith(expect.objectContaining({ geometry: GEOMETRY, issues: response.issues }));
  });

  it("does not ask for views without onViews", async () => {
    const worker = vi.fn<RenderWorker>(async () => response);
    const tool = createRunCadqueryTool({ requestId: "r", worker });
    await tool.execute!({ code: "code" }, { toolCallId: "c", messages: [] });
    expect(worker.mock.calls[0][2]).not.toHaveProperty("views");
  });

  it("drops the STL and the issue list and geometry report the summary already states from what the model sees", async () => {
    const tool = createRunCadqueryTool({ requestId: "r", worker: async () => response });
    const out = await tool.execute!({ code: "code" }, { toolCallId: "c", messages: [] });
    const forModel = await tool.toModelOutput!({ toolCallId: "c", input: { code: "code" }, output: out as never });
    const value = (forModel as { value: Record<string, unknown> }).value;
    expect(value).not.toHaveProperty("stlBase64");
    expect(value).not.toHaveProperty("issues");
    expect(value).not.toHaveProperty("geometry");
    expect(String(value.summary)).toContain("4 round holes: 4x d3.5 through along Z");
    expect(String(value.summary)).toContain("Advisory: Overhang warning");
  });
});

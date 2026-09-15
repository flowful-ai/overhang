import { describe, it, expect } from "vitest";
import { parseParameters, setParameter } from "@/lib/parameters";

const SAMPLE = `import cadquery as cq
import math

# PARAMETERS
width = 60.0   # mm
depth = 40.0   # mm
thick = 5.0    # mm
hole_d = 3.5   # mm - M3 clearance
count = 4

result = (
    cq.Workplane("XY")
    .box(width, depth, thick)
)
`;

describe("parseParameters", () => {
  it("detects all top-level numeric assignments", () => {
    const params = parseParameters(SAMPLE);
    expect(params.map(p => p.name)).toEqual(["width", "depth", "thick", "hole_d", "count"]);
  });

  it("extracts value and comment", () => {
    const params = parseParameters(SAMPLE);
    const width = params.find(p => p.name === "width")!;
    expect(width.value).toBe(60);
    expect(width.comment).toBe("mm");

    const holeD = params.find(p => p.name === "hole_d")!;
    expect(holeD.value).toBe(3.5);
    expect(holeD.comment).toBe("mm - M3 clearance");
  });

  it("stops at first non-trivial statement", () => {
    const code = `import cadquery as cq
width = 60
# mid comment is fine
depth = 40
result = cq.Workplane("XY")
thickness = 5
`;
    const params = parseParameters(code);
    expect(params.map(p => p.name)).toEqual(["width", "depth"]);
  });

  it("ignores computed expressions", () => {
    const code = `import cadquery as cq
width = 60
total = width + 10
result = None
`;
    const params = parseParameters(code);
    expect(params.map(p => p.name)).toEqual(["width"]);
  });

  it("handles negative numbers", () => {
    const code = `offset = -2.5  # mm
result = None`;
    const params = parseParameters(code);
    expect(params[0].value).toBe(-2.5);
  });

  it("handles scientific notation", () => {
    const code = `tolerance = 1e-4  # mm
scale = 1.5e2
result = None`;
    const params = parseParameters(code);
    expect(params.map(p => p.name)).toEqual(["tolerance", "scale"]);
    expect(params[0].value).toBe(0.0001);
    expect(params[1].value).toBe(150);
  });

  it("extracts unit and description", () => {
    const code = `hole_d = 3.5  # mm - M3 clearance
result = None`;
    const params = parseParameters(code);
    expect(params[0].unit).toBe("mm");
    expect(params[0].description).toBe("M3 clearance");
  });

  it("leaves unit empty when the comment isn't a unit", () => {
    const code = `factor = 2.0  # scale factor
result = None`;
    const params = parseParameters(code);
    expect(params[0].unit).toBe("");
    expect(params[0].description).toBe("scale factor");
  });

  it("records 0-indexed line numbers", () => {
    const params = parseParameters(SAMPLE);
    // Lines 0-1: imports, 2: blank, 3: comment, 4: width, 5: depth, 6: thick, 7: hole_d, 8: count
    expect(params[0].line).toBe(4);
    expect(params[1].line).toBe(5);
  });

  it("returns empty array when no parameters", () => {
    expect(parseParameters("")).toEqual([]);
    expect(parseParameters("result = cq.Workplane()")).toEqual([]);
  });
});

describe("inferRange (via parseParameters)", () => {
  it("angles are 0-360, integer", () => {
    const params = parseParameters("angle = 45  # deg\nresult = None");
    expect(params[0]).toMatchObject({ min: 0, max: 360, step: 1, isInteger: true });
  });

  it("counts are integer with dynamic max", () => {
    const params = parseParameters("count = 4\nresult = None");
    expect(params[0]).toMatchObject({ min: 1, step: 1, isInteger: true });
    expect(params[0].max).toBeGreaterThanOrEqual(50);
  });

  it("generic dimensions range 0 to 2x", () => {
    const params = parseParameters("width = 60\nresult = None");
    expect(params[0].min).toBe(0);
    expect(params[0].max).toBeGreaterThanOrEqual(120);
    expect(params[0].isInteger).toBe(false);
  });

  it("small values get fine step", () => {
    const params = parseParameters("clearance = 0.3\nresult = None");
    expect(params[0].step).toBeLessThan(1);
    expect(params[0].max).toBeGreaterThanOrEqual(0.6);
  });

  it("teeth count uses integer heuristic", () => {
    const params = parseParameters("teeth = 20\nresult = None");
    expect(params[0].isInteger).toBe(true);
    expect(params[0].step).toBe(1);
  });

  it("negative values get a range that includes the current value", () => {
    const params = parseParameters("offset = -5.0\nresult = None");
    expect(params[0].min).toBeLessThanOrEqual(-5);
    expect(params[0].max).toBeGreaterThanOrEqual(-5);
  });
});

describe("setParameter", () => {
  it("replaces the value while preserving comment and indentation", () => {
    const updated = setParameter(SAMPLE, "width", 75);
    expect(updated).toContain("width = 75   # mm");
    expect(updated).not.toContain("width = 60");
  });

  it("handles no-comment lines", () => {
    const code = "count = 4\nresult = None";
    expect(setParameter(code, "count", 8)).toBe("count = 8\nresult = None");
  });

  it("formats floats cleanly", () => {
    const code = "r = 2.5  # mm\nresult = None";
    expect(setParameter(code, "r", 3.14159)).toContain("r = 3.142");
  });

  it("returns original code when parameter not found", () => {
    expect(setParameter(SAMPLE, "nonexistent", 10)).toBe(SAMPLE);
  });

  it("round-trips: parse \u2192 set \u2192 parse gives same structure", () => {
    const modified = setParameter(SAMPLE, "width", 100);
    const params = parseParameters(modified);
    const width = params.find(p => p.name === "width")!;
    expect(width.value).toBe(100);
    expect(width.comment).toBe("mm");
  });
});

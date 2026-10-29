import { describe, it, expect } from "vitest";
import type { GeometryReport } from "../src/lib/cad-worker-protocol";
import { scoreCase, type CaseExpectation, type ObservedOutcome } from "./scoring";

describe("scoreCase", () => {
  it("case 1: not rendered at all → everything false, pass false", () => {
    const expectation: CaseExpectation = {};
    const observed: ObservedOutcome = {
      rendered: false,
      bbox: null,
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    expect(result.rendered).toBe(false);
    expect(result.watertight).toBe(false);
    expect(result.bboxOk).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("case 2: rendered, no expectations beyond default → pass true, bboxOk true", () => {
    const expectation: CaseExpectation = {};
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 10, y: 20, z: 30 },
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    expect(result.rendered).toBe(true);
    expect(result.watertight).toBe(true);
    expect(result.bboxOk).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("case 3: watertight required and non-watertight warning present → watertight false, pass false", () => {
    const expectation: CaseExpectation = { watertight: true };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 10, y: 20, z: 30 },
      warnings: ["Non-watertight mesh: topology error"],
    };
    const result = scoreCase(expectation, observed);
    expect(result.watertight).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("case 4: watertight required, warnings contain only overhang warning → watertight true, warningsCount reflects it, pass true if bbox ok", () => {
    const expectation: CaseExpectation = { watertight: true };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 10, y: 20, z: 30 },
      warnings: ["Overhang detected: part has features > 45 degrees"],
    };
    const result = scoreCase(expectation, observed);
    expect(result.watertight).toBe(true);
    expect(result.bboxOk).toBe(true);
    expect(result.warningsCount).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("case 5: sortedBbox with bbox {x: 3, y: 60, z: 40} against [[55,68],[36,52],[2,45]] → bboxOk true", () => {
    const expectation: CaseExpectation = {
      sortedBbox: [[55, 68], [36, 52], [2, 45]],
    };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 3, y: 60, z: 40 },
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    // Sorted descending: [60, 40, 3]
    // Check: 60 in [55,68]? yes; 40 in [36,52]? yes; 3 in [2,45]? yes
    expect(result.bboxOk).toBe(true);
  });

  it("case 6: sortedBbox out of range → bboxOk false, pass false", () => {
    const expectation: CaseExpectation = {
      sortedBbox: [[55, 68], [36, 52], [2, 45]],
    };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 100, y: 60, z: 40 },
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    // Sorted descending: [100, 60, 40]
    // Check: 100 in [55,68]? no
    expect(result.bboxOk).toBe(false);
    expect(result.pass).toBe(false);
  });

  it("case 7: sortedBbox expected but bbox null → bboxOk false", () => {
    const expectation: CaseExpectation = {
      sortedBbox: [[55, 68], [36, 52], [2, 45]],
    };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: null,
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    expect(result.bboxOk).toBe(false);
  });

  it("case 8a: per-axis bbox expectation {x: [10,20]} with bbox x=15 → ok", () => {
    const expectation: CaseExpectation = {
      bbox: { x: [10, 20] },
    };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 15, y: 30, z: 40 },
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    expect(result.bboxOk).toBe(true);
  });

  it("case 8b: per-axis bbox expectation {x: [10,20]} with bbox x=25 → not ok", () => {
    const expectation: CaseExpectation = {
      bbox: { x: [10, 20] },
    };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 25, y: 30, z: 40 },
      warnings: [],
    };
    const result = scoreCase(expectation, observed);
    expect(result.bboxOk).toBe(false);
  });

  it("case 9a: maxWarnings 0 with one warning → pass false", () => {
    const expectation: CaseExpectation = { maxWarnings: 0 };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 10, y: 20, z: 30 },
      warnings: ["Some warning"],
    };
    const result = scoreCase(expectation, observed);
    expect(result.warningsCount).toBe(1);
    expect(result.pass).toBe(false);
  });

  it("case 9b: maxWarnings 2 with one warning → pass true", () => {
    const expectation: CaseExpectation = { maxWarnings: 2 };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 10, y: 20, z: 30 },
      warnings: ["Some warning"],
    };
    const result = scoreCase(expectation, observed);
    expect(result.warningsCount).toBe(1);
    expect(result.pass).toBe(true);
  });

  it("case 10: empty geometry warning also fails watertight check", () => {
    const expectation: CaseExpectation = { watertight: true };
    const observed: ObservedOutcome = {
      rendered: true,
      bbox: { x: 10, y: 20, z: 30 },
      warnings: ["Empty geometry: STL contains no vertices"],
    };
    const result = scoreCase(expectation, observed);
    expect(result.watertight).toBe(false);
    expect(result.pass).toBe(false);
  });
});

describe("scoreCase features", () => {
  const geometry = (over: Partial<GeometryReport> = {}): GeometryReport => ({
    solid_count: 1,
    z_min: 0,
    bounds_min: [0, 0, 0],
    bounds_max: [60, 40, 5],
    valid: true,
    faces: { plane: 6, cylinder: 3 },
    holes: [{ diameter: 3.4, depth: 5, axis: "Z", through: true, count: 3 }],
    hole_count: 3,
    min_wall_mm: 3,
    overhang: null,
    solids: [{ volume: 100, bbox: { x: 60, y: 40, z: 5 }, z_min: 0 }],
    ...over,
  });
  const observed = (g: GeometryReport | null): ObservedOutcome => ({
    rendered: true,
    bbox: { x: 60, y: 40, z: 5 },
    warnings: [],
    geometry: g,
  });

  it("passes when hole and solid counts are in range, and reports them", () => {
    const result = scoreCase({ holes: [3, 3], solids: [1, 1] }, observed(geometry()));
    expect(result).toMatchObject({ holes: 3, solids: 1, featuresOk: true, pass: true });
  });

  it("fails a render with the right size but missing holes", () => {
    const result = scoreCase({ holes: [3, 3] }, observed(geometry({ holes: [], hole_count: 0 })));
    expect(result.bboxOk).toBe(true);
    expect(result).toMatchObject({ holes: 0, featuresOk: false, pass: false });
  });

  it("fails a hole expectation when holes were not measured", () => {
    const result = scoreCase({ holes: [3, 3] }, observed(geometry({ holes: [], hole_count: null })));
    expect(result).toMatchObject({ holes: null, featuresOk: false, pass: false });
  });

  it("fails an unexpected number of solids", () => {
    expect(scoreCase({ solids: [1, 1] }, observed(geometry({ solid_count: 2 }))).pass).toBe(false);
  });

  it("skips feature scoring without a geometry report (fixtures recorded before it)", () => {
    const result = scoreCase({ holes: [3, 3], solids: [1, 1] }, observed(null));
    expect(result).not.toHaveProperty("featuresOk");
    expect(result).not.toHaveProperty("holes");
    expect(result.pass).toBe(true);
  });

  it("skips feature scoring for cases without feature expectations", () => {
    expect(scoreCase({}, observed(geometry()))).not.toHaveProperty("featuresOk");
  });

  describe("matchingFootprints (lid covers box)", () => {
    const box = { volume: 9000, bbox: { x: 50, y: 30, z: 20 }, z_min: 0 };
    const lid = (x: number, y: number) => ({ volume: 4000, bbox: { x, y, z: 7.5 }, z_min: 0 });

    it("passes when the two parts' footprints agree within the tolerance", () => {
      const g = geometry({ solid_count: 2, solids: [lid(30.4, 50.2), box] });
      expect(scoreCase({ solids: [2, 2], matchingFootprints: 1 }, observed(g)).featuresOk).toBe(true);
    });

    it("fails a lid that does not cover the box", () => {
      const g = geometry({ solid_count: 2, solids: [box, lid(45.7, 25.7)] });
      expect(scoreCase({ matchingFootprints: 1 }, observed(g)).featuresOk).toBe(false);
    });

    it("fails a single body", () => {
      expect(scoreCase({ matchingFootprints: 1 }, observed(geometry())).featuresOk).toBe(false);
    });
  });
});

import { z } from "zod";
import type { BoundingBox, GeometryReport } from "../src/lib/cad-worker-protocol";

// Pure scoring functions: expectation + observed outcome -> score.
// No I/O, no LLM, so this is unit-testable and reused by the live runner and
// the CI replay test.

export type Range = [min: number, max: number];

export interface CaseExpectation {
  /**
   * Ranges applied to the bounding-box dimensions sorted descending.
   * Orientation-robust: a 60x40x3 bracket scores the same whether the model
   * builds it lying flat or standing up.
   */
  sortedBbox?: [Range, Range, Range];
  /** Per-axis ranges for cases where orientation is pinned. */
  bbox?: Partial<Record<"x" | "y" | "z", Range>>;
  /** Require the final render to have no watertightness/validity warnings. */
  watertight?: boolean;
  /** Upper bound on total warnings in the final render. */
  maxWarnings?: number;
  /**
   * Feature checks, scored from the worker's geometry report (skipped, not
   * failed, for renders recorded before the report existed):
   * - holes: number of round holes (counterbore + bore count as one).
   * - solids: number of separate solids.
   * - matchingFootprints: fit proxy for two-part assemblies (box + lid). The
   *   two largest solids must have footprints (their two largest bbox
   *   dimensions) within this many mm of each other, so the lid covers the
   *   box. Coarse: it does not measure the clearance of the mating feature.
   */
  holes?: Range;
  solids?: Range;
  matchingFootprints?: number;
}

export interface ObservedOutcome {
  /** At least one runCadquery call succeeded this turn. */
  rendered: boolean;
  /** Bounding box of the last successful render, if any. */
  bbox: BoundingBox | null;
  /** Warnings of the last successful render. */
  warnings: string[];
  /** Geometry report of the last successful render; absent from older fixtures. */
  geometry?: GeometryReport | null;
}

export const CaseScore = z.object({
  rendered: z.boolean(),
  watertight: z.boolean(),
  bboxOk: z.boolean(),
  warningsCount: z.number(),
  // Feature scores: present only when the case has feature expectations and
  // the render carried a geometry report (fixtures recorded before it have
  // neither, and replay to the same score).
  holes: z.number().nullable().optional(),
  solids: z.number().optional(),
  featuresOk: z.boolean().optional(),
  pass: z.boolean(),
});
export type CaseScore = z.infer<typeof CaseScore>;

// Matches the cad-worker's mesh-validity warnings (see validate_mesh in
// cad-worker/main.py): non-watertight, empty, or NaN geometry all mean the
// mesh is not a printable solid.
const NOT_SOLID_RE = /non-watertight|empty geometry|invalid geometry/i;

function inRange(value: number, [min, max]: Range): boolean {
  return value >= min && value <= max;
}

export function scoreCase(expect: CaseExpectation, observed: ObservedOutcome): CaseScore {
  const { rendered, bbox, warnings } = observed;

  const watertight = rendered && !warnings.some((w) => NOT_SOLID_RE.test(w));

  let bboxOk = rendered;
  if (expect.sortedBbox) {
    if (!bbox) {
      bboxOk = false;
    } else {
      const dims = [bbox.x, bbox.y, bbox.z].sort((a, b) => b - a);
      bboxOk = expect.sortedBbox.every((range, i) => inRange(dims[i], range));
    }
  }
  if (bboxOk && expect.bbox) {
    if (!bbox) {
      bboxOk = false;
    } else {
      bboxOk = (Object.entries(expect.bbox) as [keyof BoundingBox, Range][]).every(
        ([axis, range]) => inRange(bbox[axis], range),
      );
    }
  }

  const warningsCount = warnings.length;
  const features = scoreFeatures(expect, observed.geometry);
  const pass =
    rendered &&
    bboxOk &&
    (!expect.watertight || watertight) &&
    (expect.maxWarnings === undefined || warningsCount <= expect.maxWarnings) &&
    features?.featuresOk !== false;

  return { rendered, watertight, bboxOk, warningsCount, ...features, pass };
}

function hasFeatureExpectations(expect: CaseExpectation): boolean {
  return expect.holes !== undefined || expect.solids !== undefined || expect.matchingFootprints !== undefined;
}

/** Feature scores, or null when there is nothing to score (no expectations, or no report). */
export function scoreFeatures(
  expect: CaseExpectation,
  geometry: GeometryReport | null | undefined,
): { holes: number | null; solids: number; featuresOk: boolean } | null {
  if (!geometry || !hasFeatureExpectations(expect)) return null;
  const holes = geometry.hole_count;
  const solids = geometry.solid_count;
  // Holes that were not measured (worker deadline) fail a hole expectation:
  // the case cannot show it has them.
  const holesOk = !expect.holes || (holes !== null && inRange(holes, expect.holes));
  const solidsOk = !expect.solids || inRange(solids, expect.solids);
  const fitOk = expect.matchingFootprints === undefined || footprintsMatch(geometry, expect.matchingFootprints);
  return { holes, solids, featuresOk: holesOk && solidsOk && fitOk };
}

/** The two largest solids' footprints (two largest bbox dims) agree within `tolerance` mm. */
function footprintsMatch(geometry: GeometryReport, tolerance: number): boolean {
  if (geometry.solids.length < 2) return false;
  const [a, b] = [...geometry.solids].sort((p, q) => q.volume - p.volume);
  const footprint = (s: { bbox: BoundingBox }) => [s.bbox.x, s.bbox.y, s.bbox.z].sort((p, q) => q - p).slice(0, 2);
  const [fa, fb] = [footprint(a), footprint(b)];
  return fa.every((d, i) => Math.abs(d - fb[i]) <= tolerance);
}

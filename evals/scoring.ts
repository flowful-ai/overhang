import { z } from "zod";
import type { BoundingBox } from "../src/lib/cad-worker-protocol";

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
}

export interface ObservedOutcome {
  /** At least one runCadquery call succeeded this turn. */
  rendered: boolean;
  /** Bounding box of the last successful render, if any. */
  bbox: BoundingBox | null;
  /** Warnings of the last successful render. */
  warnings: string[];
}

export const CaseScore = z.object({
  rendered: z.boolean(),
  watertight: z.boolean(),
  bboxOk: z.boolean(),
  warningsCount: z.number(),
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
  const pass =
    rendered &&
    bboxOk &&
    (!expect.watertight || watertight) &&
    (expect.maxWarnings === undefined || warningsCount <= expect.maxWarnings);

  return { rendered, watertight, bboxOk, warningsCount, pass };
}

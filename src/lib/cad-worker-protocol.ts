import { z } from "zod";

// Single source of truth for the two cad-worker contracts.
//
// 1. WIRE FORMAT (Python → TS over HTTP). Mirrored on the Python side by the
//    Pydantic RenderResponse / ThreeMFResponse models in cad-worker/main.py.
//    snake_case, .strict() so a new Python field can't silently land without
//    TS knowing.
//
// 2. TOOL-RESULT FORMAT (runCadquery tool → LLM and UI). camelCase
//    discriminated union. Both src/app/api/generate-cad/route.ts (producer)
//    and src/components/ChatInterface.tsx (consumer) derive their types from
//    CadqueryToolResult here.

export const BoundingBox = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

export const WorkerMetrics = z.object({
  bbox: BoundingBox,
  volume: z.number(),
});
export type WorkerMetrics = z.infer<typeof WorkerMetrics>;

// A printability finding. "blocking": the file won't print as intended (not a
// closed solid, off the build plate, walls below what a nozzle can lay down);
// "advisory": printable but worth a look. Classified by the worker
// (inspect_mesh and geometry_report in cad-worker/main.py).
export const RenderIssue = z.object({
  severity: z.enum(["blocking", "advisory"]),
  message: z.string(),
});
export type RenderIssue = z.infer<typeof RenderIssue>;

// What the worker measured on the exact BRep, so the model can check the
// result against the request (GeometryModel in cad-worker/main.py). A
// measurement that did not complete (deadline, failure) is null.
export const GeometryReport = z.object({
  solid_count: z.number(),
  z_min: z.number().nullable(),
  bounds_min: z.array(z.number()).nullable(),
  bounds_max: z.array(z.number()).nullable(),
  valid: z.boolean().nullable(),
  faces: z.record(z.string(), z.number()),
  holes: z.array(
    z.object({ diameter: z.number(), depth: z.number(), axis: z.string(), through: z.boolean(), count: z.number() }),
  ),
  /** Total holes; null when hole detection did not complete. */
  hole_count: z.number().nullable(),
  /** Thinnest wall covering a real share of the surface (2nd percentile of ray-cast samples). */
  min_wall_mm: z.number().nullable(),
  /** Steepest overhang (degrees from vertical, 90 = flat ceiling), where, and the total overhang area. */
  overhang: z.object({ worst_deg: z.number(), at: z.array(z.number()), area_mm2: z.number() }).nullable(),
  solids: z.array(z.object({ volume: z.number(), bbox: BoundingBox, z_min: z.number() })),
});
export type GeometryReport = z.infer<typeof GeometryReport>;

// A shaded preview image of the render (cad-worker/views.py), for the model's
// visual self-check. Only returned when the request asked for views.
export const RenderView = z.object({ name: z.string(), png_base64: z.string() });
export type RenderView = z.infer<typeof RenderView>;

export const WorkerRenderResult = z
  .object({
    stl_base64: z.string(),
    metrics: WorkerMetrics,
    // Python emits null (not []) when there are no warnings; callers coalesce.
    // The messages of `issues`, in the same order.
    warnings: z.array(z.string()).nullable(),
    // nullish: absent from workers and eval fixtures that predate them.
    issues: z.array(RenderIssue).nullish(),
    geometry: GeometryReport.nullish(),
    views: z.array(RenderView).nullish(),
    console_output: z.string().nullable(),
  })
  .strict();
export type WorkerRenderResult = z.infer<typeof WorkerRenderResult>;

export const WorkerThreeMFResult = z
  .object({
    threemf_base64: z.string(),
    console_output: z.string().nullable(),
  })
  .strict();
export type WorkerThreeMFResult = z.infer<typeof WorkerThreeMFResult>;

// Discriminated on `success`. The success branch carries everything the LLM
// needs to reason about the next step (metrics, summary, warnings) plus what
// the UI needs to render (stlBase64, code). The failure branch only carries
// the sanitized error and the echoed code so the LLM can fix it. Preview
// images are not part of it: they would stream to the UI and be stored with
// the chat, so the agent turn hands them to the model directly.
export const CadqueryToolResult = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    code: z.string(),
    stlBase64: z.string(),
    warnings: z.array(z.string()),
    // Optional: results stored before they existed don't have them.
    issues: z.array(RenderIssue).optional(),
    geometry: GeometryReport.optional(),
    metrics: WorkerMetrics,
    summary: z.string(),
  }),
  z.object({
    success: z.literal(false),
    code: z.string(),
    error: z.string(),
  }),
]);
export type CadqueryToolResult = z.infer<typeof CadqueryToolResult>;

// OUTGOING projections: before the conversation is re-sent to the agent, the
// client narrows success outputs — strip-stl.ts removes stlBase64, and
// next-turn.ts replaces the whole output with projectEditedBasisOutput() when
// the user edited the basis code. The projected shapes are intentionally
// subsets of the success branch above and are never runtime-validated against
// it; if server-side validation of resubmitted tool outputs is ever added, it
// must accept them.

export const EDITED_BASIS_SUMMARY =
  "The user edited this code after the render; metrics and warnings for the edited version are not known yet.";

/**
 * Tool output projected for the next turn when the user edited the code after
 * the render. An ALLOWLIST, not a field-by-field strip: the recorded
 * summary/metrics/warnings describe the pre-edit geometry, and any field added
 * to the success branch later is dropped here by default instead of silently
 * surviving with stale pre-edit values.
 */
export function projectEditedBasisOutput(
  editedCode: string,
): Pick<Extract<CadqueryToolResult, { success: true }>, "success" | "code" | "summary"> {
  // Typed as a Pick of the success branch, so "intentional subset" is checked
  // by the compiler rather than asserted in prose: renaming or retyping a
  // field above breaks here instead of silently drifting.
  return { success: true, code: editedCode, summary: EDITED_BASIS_SUMMARY };
}

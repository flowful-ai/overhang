import { NextResponse } from "next/server";
import { renderCad } from "@/lib/cad-render";
import { httpStatusForWorkerFailure } from "@/lib/cad-worker";
import { withRoute } from "@/lib/api-handler";
import { RENDER_POOL, withPoolSlot } from "@/lib/in-flight";
import { CodeBodySchema } from "@/lib/utils";

// Manual re-render from the editor / parameters panel. Shares renderCad with the
// agent tool, so this path now normalizes punctuation too (it previously called
// the worker raw, so a pasted em-dash SyntaxError'd here but healed via chat).
export const POST = withRoute(
  { rateKey: "render", rateLimit: 20, schema: CodeBodySchema },
  async ({ code }, { requestId }) =>
    // Callers share a global concurrency pool (MAX_CONCURRENT_RENDERS).
    withPoolSlot(RENDER_POOL, async () => {
      const r = await renderCad(code, requestId);
      if (!r.success) {
        // renderCad already sanitized the message; return it directly in
        // withRoute's { error } shape rather than round-tripping through a
        // throw. Status policy lives in httpStatusForWorkerFailure (shared with
        // withRoute's catch, so export-3mf classifies identically).
        const status = httpStatusForWorkerFailure(r.workerStatus);
        console.error(`[${requestId}] render-cad failed (${status}): ${r.error}`);
        return NextResponse.json({ error: r.error }, { status });
      }
      return NextResponse.json({
        stlBase64: r.stlBase64,
        metrics: r.metrics,
        warnings: r.warnings.length ? r.warnings : null,
      });
    }),
);

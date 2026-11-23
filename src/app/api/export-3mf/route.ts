import { NextResponse } from "next/server";
import { exportCad3mf } from "@/lib/cad-render";
import { withRoute } from "@/lib/api-handler";
import { RENDER_POOL, withPoolSlot } from "@/lib/in-flight";
import { CodeBodySchema } from "@/lib/utils";

export const POST = withRoute(
  { rateKey: "export3mf", rateLimit: 20, schema: CodeBodySchema },
  async ({ code }, { requestId, signal }) =>
    // Runs the script on the worker like render-cad, so it draws from the same
    // pool (MAX_CONCURRENT_RENDERS) and goes through the same normalization
    // and busy retries (exportCad3mf). The request signal stops the worker
    // call when the client disconnects.
    withPoolSlot(RENDER_POOL, async () => {
      const data = await exportCad3mf(code, requestId, { signal });
      return NextResponse.json({ threemfBase64: data.threemf_base64 });
    }),
);

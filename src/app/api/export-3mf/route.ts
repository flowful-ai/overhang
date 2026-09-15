import { NextResponse } from "next/server";
import { exportThreeMF } from "@/lib/cad-worker";
import { withRoute } from "@/lib/api-handler";
import { RENDER_POOL, withPoolSlot } from "@/lib/in-flight";
import { CodeBodySchema } from "@/lib/utils";

export const POST = withRoute(
  { rateKey: "export3mf", rateLimit: 20, schema: CodeBodySchema },
  async ({ code }, { requestId }) =>
    // Runs the script on the worker like render-cad, so it draws from the same
    // pool (MAX_CONCURRENT_RENDERS).
    withPoolSlot(RENDER_POOL, async () => {
      const data = await exportThreeMF(code, requestId);
      return NextResponse.json({ threemfBase64: data.threemf_base64 });
    }),
);

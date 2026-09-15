import { NextResponse } from "next/server";
import { pingCadWorker } from "@/lib/cad-worker";

const DEEP_CHECK_TIMEOUT_MS = 2000;

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";

  const checks: Record<string, "ok" | "missing" | "unreachable"> = {
    openrouter_key: process.env.OPENROUTER_API_KEY ? "ok" : "missing",
  };

  if (deep) {
    checks.cad_worker = (await pingCadWorker(DEEP_CHECK_TIMEOUT_MS)) ? "ok" : "unreachable";
  }

  const ok = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}

import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { HttpStatusError } from "@/lib/http-error";
import { toSanitizedMessage } from "@/lib/sanitize-error";
import { generateRequestId } from "@/lib/utils";

// Default ceiling for inbound request bodies. Routes that legitimately need
// more (e.g. generate-cad ships base64 viewport snapshots) opt up via
// `bodyCap`. Enforced twice: a Content-Length precheck, then a byte counter
// while the body streams in, so a chunked upload (no Content-Length) or a
// lying header can't push past it.
const DEFAULT_BODY_CAP = 1 * 1024 * 1024;

interface RouteConfig<T> {
  // Stable string used to namespace the rate-limit bucket per route
  // (e.g. "render", "export3mf"). Combined with the client IP.
  rateKey: string;
  // Max requests per 1-minute window from a single client IP.
  rateLimit: number;
  // Zod schema for the JSON body. Errors are surfaced as 400.
  schema: ZodType<T>;
  // Max accepted request body, in bytes. Defaults to 1 MB.
  bodyCap?: number;
  // Name of an env var that, when set to "1", returns 503 before any other
  // work. Kill switch for cost / incident response.
  killSwitchEnv?: string;
}

type Handler<T> = (
  input: T,
  ctx: { requestId: string; signal: AbortSignal },
) => Promise<Response | NextResponse>;

function tooLarge(bodyCap: number) {
  return NextResponse.json(
    { error: `Request body too large (limit ${bodyCap} bytes).` },
    { status: 413 },
  );
}

/**
 * Reads the body as UTF-8 text, giving up as soon as more than `cap` bytes
 * have arrived. Returns null when the cap was exceeded.
 */
export async function readBodyCapped(req: Request, cap: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Wraps a Next.js POST handler with: kill switch + rate-limit + body cap +
 * JSON parse + Zod validation + uniform error shape + request ID
 * logging.
 *
 * The handler may return any `Response` — including a streaming response
 * (e.g. `streamText(...).toUIMessageStreamResponse(...)`); the wrapper passes
 * it through unchanged.
 */
export function withRoute<T>(config: RouteConfig<T>, handler: Handler<T>) {
  return async function POST(req: Request): Promise<Response | NextResponse> {
    const requestId = generateRequestId();
    console.log(`[${requestId}] ${config.rateKey} start`);

    // Kill switch first: during an incident we want to fail fast without
    // consuming a rate-limit slot or reading the body.
    if (config.killSwitchEnv && process.env[config.killSwitchEnv] === "1") {
      return NextResponse.json(
        { error: "This endpoint is temporarily disabled. Please try again later." },
        { status: 503 },
      );
    }

    const ip = getClientIp(req);
    if (!checkRateLimit(`${config.rateKey}:${ip}`, config.rateLimit)) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a moment." },
        { status: 429 },
      );
    }

    // Cheap precheck on the declared length; the streaming counter below is
    // the real guard.
    const bodyCap = config.bodyCap ?? DEFAULT_BODY_CAP;
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > bodyCap) return tooLarge(bodyCap);

    const text = await readBodyCapped(req, bodyCap).catch(() => "");
    if (text === null) return tooLarge(bodyCap);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Falls through to the schema, which rejects null with a 400.
    }
    const parsed = config.schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }

    try {
      return await handler(parsed.data, { requestId, signal: req.signal });
    } catch (e: unknown) {
      console.error(`[${requestId}] ${config.rateKey} handler error:`, e);
      // An error may declare the status its route should return (see
      // HttpStatusError; cad-worker call failures set it so a user's code
      // error is a 400 and a worker load-shed stays a retryable 503 instead
      // of every worker-backed route reporting a blanket 500). Anything that
      // doesn't declare one is a server fault.
      const declared = (e as Partial<HttpStatusError> | null)?.httpStatus;
      return NextResponse.json(
        { error: toSanitizedMessage(e) },
        { status: typeof declared === "number" ? declared : 500 },
      );
    }
  };
}

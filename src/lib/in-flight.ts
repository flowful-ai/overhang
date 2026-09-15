import { NextResponse } from "next/server";

// Concurrency guards for the expensive endpoints.
//
// Generation is free, but each turn drives an expensive LLM + CAD-worker run.
// Callers have no identity to key on, so they share a global pool per
// endpoint, capped by env (see concurrencyLimit).
//
// In-memory, so it bounds concurrency per server instance — the same tradeoff
// as the rate limiter in rate-limit.ts. For a multi-instance deployment this
// should move to a shared store (e.g. Redis).

// Pool name -> live tokens. Each acquisition gets its own token, so release is
// token-scoped: a double release can never free someone else's slot.
const pools = new Map<string, Set<symbol>>();

export const GENERATION_POOL = "generate";
export const RENDER_POOL = "render";
// Env vars sizing each pool, most specific first. The ANON_* names are the
// pre-rename spellings, still read so existing deploys keep their settings.
const LIMIT_ENV: Record<string, readonly string[]> = {
  [GENERATION_POOL]: ["MAX_CONCURRENT_GENERATIONS", "ANON_MAX_CONCURRENT_GENERATIONS"],
  [RENDER_POOL]: ["MAX_CONCURRENT_RENDERS", "ANON_MAX_CONCURRENT_RENDERS"],
};
// Per pool. The generation and render pools are independent (render-cad and
// export-3mf share the render pool), so with both defaults traffic can still
// exceed the worker's CAD_MAX_CONCURRENT_RENDERS; the worker then load-sheds
// with 503, which is the backstop. This cap bounds LLM spend and queue depth,
// not exact worker occupancy.
const DEFAULT_LIMIT = 4;

/** Max concurrent requests for `pool`, read from env at call time. The first
 * env var holding a positive integer wins; otherwise the default. */
export function concurrencyLimit(pool: string): number {
  for (const name of LIMIT_ENV[pool] ?? []) {
    const n = Number(process.env[name]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_LIMIT;
}

/** Returns a release token, or null when `pool` already holds `limit` slots. */
export function acquirePoolSlot(pool: string, limit: number): symbol | null {
  const live = pools.get(pool) ?? new Set<symbol>();
  if (live.size >= limit) return null;
  const token = Symbol(pool);
  live.add(token);
  pools.set(pool, live);
  return token;
}

export function releasePoolSlot(pool: string, token: symbol): void {
  pools.get(pool)?.delete(token);
}

function busyResponse() {
  // 503, like the worker's load-shed: the server is saturated, not this caller.
  return NextResponse.json(
    { error: "Overhang is busy right now. Please try again in a moment." },
    { status: 503 },
  );
}

// Owns the full generation-lease lifecycle so the route doesn't have to:
// acquire, hand `run` a guarded (idempotent, token-scoped) release, arm a safety
// timer so a slot can't leak if `run`'s terminal events never fire, release on a
// synchronous throw, and refuse when no slot is free. `run` is responsible only
// for calling `release` when its turn ends, on every early return AND wired into
// the stream's terminal events, since the turn outlives the handler.
//
// Shared pool of MAX_CONCURRENT_GENERATIONS, 503 when full.
//
// `safetyTimeoutMs` is the backstop delay: set it a bit longer than the longest
// possible turn (the generate route derives it from the agent turn timeout).
export async function withGenerationLease(
  run: (release: () => void) => Promise<Response>,
  safetyTimeoutMs: number,
): Promise<Response> {
  const token = acquirePoolSlot(GENERATION_POOL, concurrencyLimit(GENERATION_POOL));
  if (!token) return busyResponse();

  let released = false;
  // Guarded release: idempotent, and releases by token so a late fire can never
  // free a *newer* generation's slot. unref so the timer never keeps the process
  // alive on its own.
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);
    releasePoolSlot(GENERATION_POOL, token);
  };
  const safety = setTimeout(release, safetyTimeoutMs);
  safety.unref?.();

  try {
    return await run(release);
  } catch (e) {
    // run threw before it could wire release into its terminal events.
    release();
    throw e;
  }
}

// Caps concurrent calls to a non-streaming route (render-cad, export-3mf). The
// slot is held for exactly the duration of `run`.
export async function withPoolSlot(
  pool: string,
  run: () => Promise<Response>,
): Promise<Response> {
  const token = acquirePoolSlot(pool, concurrencyLimit(pool));
  if (!token) return busyResponse();
  try {
    return await run();
  } finally {
    releasePoolSlot(pool, token);
  }
}

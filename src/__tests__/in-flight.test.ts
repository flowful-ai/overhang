import { describe, it, expect, vi, afterEach } from "vitest";
import {
  GENERATION_POOL,
  RENDER_POOL,
  acquirePoolSlot,
  concurrencyLimit,
  releasePoolSlot,
  withPoolSlot,
} from "@/lib/in-flight";

// Callers share a global pool per endpoint. Pools are process-wide state: tests
// use unique pool names except where they exercise the real pools.
const pool = () => `pool-${Math.random()}`;

const LIMIT_ENV_NAMES = [
  "MAX_CONCURRENT_GENERATIONS",
  "ANON_MAX_CONCURRENT_GENERATIONS",
  "MAX_CONCURRENT_RENDERS",
  "ANON_MAX_CONCURRENT_RENDERS",
];
const clearLimitEnv = () => LIMIT_ENV_NAMES.forEach((name) => vi.stubEnv(name, ""));

afterEach(() => vi.unstubAllEnvs());

describe("concurrency pools", () => {
  it("grants up to `limit` slots and refuses the next", () => {
    const p = pool();
    const a = acquirePoolSlot(p, 2);
    const b = acquirePoolSlot(p, 2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(acquirePoolSlot(p, 2)).toBeNull();
    releasePoolSlot(p, a!);
    expect(acquirePoolSlot(p, 2)).not.toBeNull();
  });

  it("a double release does not free another caller's slot", () => {
    const p = pool();
    const a = acquirePoolSlot(p, 2)!;
    acquirePoolSlot(p, 2);
    releasePoolSlot(p, a);
    releasePoolSlot(p, a);
    acquirePoolSlot(p, 2);
    expect(acquirePoolSlot(p, 2)).toBeNull();
  });

  it("releasing an unknown token is a harmless no-op", () => {
    const p = pool();
    expect(() => releasePoolSlot(p, Symbol("phantom"))).not.toThrow();
    expect(acquirePoolSlot(p, 1)).not.toBeNull();
  });
});

describe("concurrencyLimit", () => {
  it("defaults to 4 on unset or invalid values", () => {
    clearLimitEnv();
    expect(concurrencyLimit(GENERATION_POOL)).toBe(4);
    expect(concurrencyLimit(RENDER_POOL)).toBe(4);
    for (const bad of ["0", "-1", "abc", "2.5"]) {
      vi.stubEnv("MAX_CONCURRENT_GENERATIONS", bad);
      expect(concurrencyLimit(GENERATION_POOL)).toBe(4);
    }
  });

  it("reads MAX_CONCURRENT_GENERATIONS and MAX_CONCURRENT_RENDERS independently", () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "7");
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "9");
    expect(concurrencyLimit(GENERATION_POOL)).toBe(7);
    expect(concurrencyLimit(RENDER_POOL)).toBe(9);
  });

  it("falls back to the pre-rename ANON_* names when the new ones are unset", () => {
    clearLimitEnv();
    vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "5");
    vi.stubEnv("ANON_MAX_CONCURRENT_RENDERS", "6");
    expect(concurrencyLimit(GENERATION_POOL)).toBe(5);
    expect(concurrencyLimit(RENDER_POOL)).toBe(6);
  });

  it("prefers the new names over the ANON_* fallback", () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "2");
    vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "5");
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "3");
    vi.stubEnv("ANON_MAX_CONCURRENT_RENDERS", "6");
    expect(concurrencyLimit(GENERATION_POOL)).toBe(2);
    expect(concurrencyLimit(RENDER_POOL)).toBe(3);
  });

  it("uses the ANON_* fallback when the new name holds an invalid value", () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "abc");
    vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "5");
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "0");
    vi.stubEnv("ANON_MAX_CONCURRENT_RENDERS", "6");
    expect(concurrencyLimit(GENERATION_POOL)).toBe(5);
    expect(concurrencyLimit(RENDER_POOL)).toBe(6);
  });

  it("defaults to 4 when both the new and the ANON_* name are invalid", () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "abc");
    vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "-2");
    expect(concurrencyLimit(GENERATION_POOL)).toBe(4);
  });

  it("defaults for a pool with no env mapping", () => {
    expect(concurrencyLimit(pool())).toBe(4);
  });
});

describe("withPoolSlot", () => {
  it("returns 503 with the busy error when the pool is full", async () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "1");
    const held = acquirePoolSlot(RENDER_POOL, 1)!;
    try {
      const run = vi.fn(async () => new Response("ok"));
      const res = await withPoolSlot(RENDER_POOL, run);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Overhang is busy right now. Please try again in a moment." });
      expect(run).not.toHaveBeenCalled();
    } finally {
      releasePoolSlot(RENDER_POOL, held);
    }
  });

  it("releases the slot after run, even when run throws", async () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "1");
    await expect(
      withPoolSlot(RENDER_POOL, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await withPoolSlot(RENDER_POOL, async () => new Response("ok"))).status).toBe(200);
    expect((await withPoolSlot(RENDER_POOL, async () => new Response("ok"))).status).toBe(200);
  });

  it("keeps the generation and render pools independent", async () => {
    clearLimitEnv();
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "1");
    vi.stubEnv("MAX_CONCURRENT_RENDERS", "1");
    const held = acquirePoolSlot(GENERATION_POOL, 1)!;
    try {
      expect((await withPoolSlot(RENDER_POOL, async () => new Response("ok"))).status).toBe(200);
    } finally {
      releasePoolSlot(GENERATION_POOL, held);
    }
  });
});

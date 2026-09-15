import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GENERATION_POOL, acquirePoolSlot, releasePoolSlot, withGenerationLease } from "@/lib/in-flight";

const ok = () => new Response("ok");
// Backstop delay for calls that don't exercise the timer (they release first).
const SAFETY_MS = 60_000;

// Every test runs with a one-slot generation pool, so "is the slot held?" is a
// non-destructive probe: acquire returns null when occupied, and a successful
// probe is released straight away.
const isHeld = () => {
  const token = acquirePoolSlot(GENERATION_POOL, 1);
  if (!token) return true;
  releasePoolSlot(GENERATION_POOL, token);
  return false;
};

beforeEach(() => {
  vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "1");
  vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("withGenerationLease", () => {
  it("runs inside the shared generation pool and frees the slot on release", async () => {
    const run = vi.fn(async (release: () => void) => {
      expect(isHeld()).toBe(true);
      release();
      return ok();
    });
    const res = await withGenerationLease(run, SAFETY_MS);
    expect(run).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(isHeld()).toBe(false);
  });

  it("returns 503 with the busy error without running when the pool is full", async () => {
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "2");
    const releases: Array<() => void> = [];
    const hold = async (release: () => void) => {
      releases.push(release);
      return ok();
    };
    try {
      expect((await withGenerationLease(hold, SAFETY_MS)).status).toBe(200);
      expect((await withGenerationLease(hold, SAFETY_MS)).status).toBe(200);

      const run = vi.fn(async () => ok());
      const refused = await withGenerationLease(run, SAFETY_MS);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: "Overhang is busy right now. Please try again in a moment." });
      expect(run).not.toHaveBeenCalled();

      releases[0]();
      releases[0](); // idempotent: must not free the other held slot too
      expect((await withGenerationLease(hold, SAFETY_MS)).status).toBe(200);
      expect((await withGenerationLease(run, SAFETY_MS)).status).toBe(503);
    } finally {
      releases.forEach((r) => r());
    }
  });

  it("sizes the pool from the ANON_MAX_CONCURRENT_GENERATIONS fallback", async () => {
    vi.stubEnv("MAX_CONCURRENT_GENERATIONS", "");
    vi.stubEnv("ANON_MAX_CONCURRENT_GENERATIONS", "1");
    let release!: () => void;
    await withGenerationLease(async (r) => {
      release = r;
      return ok();
    }, SAFETY_MS);
    try {
      expect((await withGenerationLease(async () => ok(), SAFETY_MS)).status).toBe(503);
    } finally {
      release();
    }
  });

  it("releases the slot and rethrows when run throws synchronously", async () => {
    await expect(
      withGenerationLease(async () => {
        throw new Error("boom");
      }, SAFETY_MS),
    ).rejects.toThrow("boom");
    expect(isHeld()).toBe(false);
  });

  it("a stale release from an earlier generation does not free a later one", async () => {
    let captured!: () => void;
    await withGenerationLease(async (release) => {
      captured = release;
      release();
      return ok();
    }, SAFETY_MS);
    await withGenerationLease(async (release) => {
      captured(); // stale release from the first generation
      expect(isHeld()).toBe(true); // second generation still holds
      release();
      return ok();
    }, SAFETY_MS);
    expect(isHeld()).toBe(false);
  });

  it("the safety timer frees a leaked slot when run never releases", async () => {
    vi.useFakeTimers();
    try {
      // run resolves a Response but never calls release (torn-down stream).
      await withGenerationLease(async () => ok(), 1000);
      expect(isHeld()).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(isHeld()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

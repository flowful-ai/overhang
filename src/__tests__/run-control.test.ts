import { describe, it, expect } from "vitest";
import { isStopGuarded, STOP_GUARD_MS } from "@/components/chat/run-control";

describe("isStopGuarded", () => {
  it("ignores Stop right after the run starts (double-click on Send)", () => {
    expect(isStopGuarded(1000 + 120, 1000)).toBe(true);
  });

  it("accepts Stop once the guard window has passed", () => {
    expect(isStopGuarded(1000 + STOP_GUARD_MS, 1000)).toBe(false);
    expect(isStopGuarded(5000, 1000)).toBe(false);
  });

  it("accepts Stop when no run start was recorded", () => {
    expect(isStopGuarded(1000, null)).toBe(false);
  });
});

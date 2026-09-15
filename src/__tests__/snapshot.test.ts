import { describe, it, expect } from "vitest";
import { snapshotSize, SNAPSHOT_MAX_EDGE } from "@/components/chat/snapshot";

describe("snapshotSize", () => {
  it("caps the long edge of a landscape canvas and keeps the aspect ratio", () => {
    expect(snapshotSize(3840, 2160)).toEqual({ width: 1024, height: 576 });
  });

  it("caps the long edge of a portrait canvas", () => {
    expect(snapshotSize(1000, 3000)).toEqual({ width: 341, height: 1024 });
  });

  it("never upscales a small canvas", () => {
    expect(snapshotSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(snapshotSize(SNAPSHOT_MAX_EDGE, SNAPSHOT_MAX_EDGE)).toEqual({ width: 1024, height: 1024 });
  });

  it("keeps at least one pixel on extreme aspect ratios", () => {
    expect(snapshotSize(100000, 10)).toEqual({ width: 1024, height: 1 });
  });

  it("honors a custom max edge", () => {
    expect(snapshotSize(2000, 1000, 500)).toEqual({ width: 500, height: 250 });
  });

  it("returns null when there is nothing to draw", () => {
    expect(snapshotSize(0, 100)).toBeNull();
    expect(snapshotSize(100, -1)).toBeNull();
    expect(snapshotSize(Number.NaN, 100)).toBeNull();
    expect(snapshotSize(Infinity, 100)).toBeNull();
  });
});

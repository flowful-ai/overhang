// Viewport snapshots attached to a prompt. A full-resolution PNG of a 4K
// canvas is several MB and is resent with the turn, so snapshots are
// downscaled to a JPEG with a bounded long edge (the server caps image size).

export const SNAPSHOT_MAX_EDGE = 1024;
export const SNAPSHOT_JPEG_QUALITY = 0.85;
// JPEG has no alpha: the WebGL canvas is transparent, so paint the viewer's
// light background under it instead of letting it turn black.
const SNAPSHOT_BACKGROUND = "#f9fafb";

// Output size preserving aspect ratio, never upscaling. Null for a canvas with
// no drawable area. Pure; unit-tested in snapshot.test.ts.
export function snapshotSize(
  width: number,
  height: number,
  maxEdge: number = SNAPSHOT_MAX_EDGE,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Browser-only: draw the source canvas into a downscaled canvas and encode it.
export function captureSnapshot(source: HTMLCanvasElement): string | null {
  const size = snapshotSize(source.width, source.height);
  if (!size) return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = SNAPSHOT_BACKGROUND;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return canvas.toDataURL("image/jpeg", SNAPSHOT_JPEG_QUALITY);
}

// Shared strings with no runtime dependencies, safe to import from both server
// routes and client components.

// Text part left in place of an image dropped from an older user turn, by the
// client when it strips old snapshots and by /api/generate-cad when it drops
// an unusable one. Must stay byte-identical on both sides: the route excludes
// parts equal to it from the prompt length limit.
export const OMITTED_SNAPSHOT_TEXT = "[Snapshot omitted from history]";

import type { UIMessage } from "ai";
import { OMITTED_SNAPSHOT_TEXT } from "@/lib/constants";

// Text left in place of a snapshot dropped from an older user turn. The model
// still learns that the user attached a view there (so its earlier reply about
// "the snapshot" stays coherent), and the restored chat bubble can show a
// small marker instead of a thumbnail. MessageList hides this exact text.
// Shared with /api/generate-cad, which exempts it from the prompt length cap;
// src/lib/constants.ts has no runtime dependencies, so it is client-safe.
export { OMITTED_SNAPSHOT_TEXT };

type Part = Record<string, unknown>;

function isImagePart(p: Part): boolean {
  if (p.type !== "file") return false;
  if (typeof p.mediaType === "string" && p.mediaType.startsWith("image/")) return true;
  return typeof p.url === "string" && p.url.startsWith("data:image/");
}

// `image/jpeg` from `data:image/jpeg;base64,...`, else null.
export function dataUrlMediaType(url: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(url);
  return match ? match[1] : null;
}

// assistant-ui labels every image part `image/png` regardless of its bytes;
// snapshots are JPEG, so take the type from the data URL itself.
function withAccurateMediaType(p: Part): Part {
  const actual = typeof p.url === "string" ? dataUrlMediaType(p.url) : null;
  return actual && actual !== p.mediaType ? { ...p, mediaType: actual } : p;
}

/**
 * Image policy for outgoing requests and localStorage: only the newest user
 * message keeps its image parts. Every older user message loses its images and
 * gets a single OMITTED_SNAPSHOT_TEXT part instead. `keepLatest: false` drops
 * the newest one too (the fallback when storage is full). Idempotent; returns
 * the input array when nothing changes. Unit-tested in strip-images.test.ts.
 */
export function stripOlderImages<M extends UIMessage>(
  messages: M[],
  { keepLatest = true }: { keepLatest?: boolean } = {},
): M[] {
  let latestUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      latestUser = i;
      break;
    }
  }
  let changed = false;
  const next = messages.map((m, i) => {
    if (m.role !== "user" || !Array.isArray(m.parts)) return m;
    const parts = m.parts as unknown as Part[];
    if (!parts.some(isImagePart)) return m;
    if (keepLatest && i === latestUser) {
      const fixed = parts.map((p) => (isImagePart(p) ? withAccurateMediaType(p) : p));
      if (fixed.every((p, j) => p === parts[j])) return m;
      changed = true;
      return { ...m, parts: fixed as unknown as M["parts"] };
    }
    changed = true;
    const kept = parts.filter((p) => !isImagePart(p));
    if (!kept.some((p) => p.type === "text" && p.text === OMITTED_SNAPSHOT_TEXT)) {
      kept.push({ type: "text", text: OMITTED_SNAPSHOT_TEXT });
    }
    return { ...m, parts: kept as unknown as M["parts"] };
  });
  return changed ? next : messages;
}

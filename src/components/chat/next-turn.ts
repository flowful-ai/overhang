import type { UIMessage } from "ai";
import { projectEditedBasisOutput } from "@/lib/cad-worker-protocol";
import { TOOL_NAME } from "./constants";
import { stripStlFromMessages } from "./strip-stl";
import { stripOlderImages } from "./strip-images";

// Projects the outgoing conversation for the next agent turn: the *basis* the
// agent builds on is the working copy when the user has edited it, otherwise
// the current design already in the thread. We patch the newest successful
// runCadquery tool result's `code` in place of threading a separate field, then
// strip STL and older snapshots as usual (see strip-stl.ts, strip-images.ts).
// Pure; unit-tested in next-turn.test.ts and strip-images.test.ts.
export function forNextTurn<M extends UIMessage>(messages: M[], workingCode: string): M[] {
  const withBasis = workingCode ? patchBasisCode(messages, workingCode) : messages;
  return stripStlFromMessages(stripOlderImages(withBasis));
}

// Replace the code of the newest successful runCadquery tool result with the
// working copy, when it differs. Walks newest -> oldest so an earlier tool call
// is never touched. Returns the input unchanged when nothing needs patching.
//
// Must select the SAME tool call as deriveCurrentDesign (use-current-design.ts):
// the working copy is derived from that call's code and patched back onto it, so
// the "newest successful runCadquery" predicate has to stay in lockstep here and
// there (they run on different message shapes — UIMessage vs ThreadMessage — so
// the walk can't be literally shared).
function patchBasisCode<M extends UIMessage>(messages: M[], workingCode: string): M[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!Array.isArray(m.parts)) continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j] as Record<string, unknown>;
      if (p.type !== `tool-${TOOL_NAME}` || !p.output) continue;
      const out = p.output as { success?: boolean; code?: string };
      if (!out.success || !out.code) continue;
      // Found the current design's tool call. No-op if the user hasn't changed it.
      if (out.code === workingCode) return messages;
      const parts = [...m.parts];
      // The recorded summary/metrics/warnings describe the PRE-edit geometry;
      // the projection replaces the output wholesale (see cad-worker-protocol).
      parts[j] = {
        ...p,
        output: projectEditedBasisOutput(workingCode),
      } as (typeof m.parts)[number];
      const next = [...messages];
      next[i] = { ...m, parts } as M;
      return next;
    }
  }
  return messages;
}

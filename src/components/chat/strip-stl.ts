import type { UIMessage } from "ai";
import { TOOL_NAME } from "./constants";

/**
 * stlBase64 is large; strip it from prior tool results before re-sending the
 * full conversation to the LLM (and before persisting to localStorage). The
 * model only needs to know the prior code + warnings; the STL bytes are not
 * useful context.
 */
export function stripStlFromMessages<M extends UIMessage>(messages: M[]): M[] {
  return messages.map((m) => {
    if (!Array.isArray(m.parts)) return m;
    const next = {
      ...m,
      parts: m.parts.map((p: Record<string, unknown>) => {
        if (typeof p.type === "string" && p.type === `tool-${TOOL_NAME}` && p.output) {
          const { stlBase64: _omit, ...rest } = p.output as {
            stlBase64?: string;
            [k: string]: unknown;
          };
          return { ...p, output: rest };
        }
        return p;
      }) as typeof m.parts,
    };
    return next;
  });
}

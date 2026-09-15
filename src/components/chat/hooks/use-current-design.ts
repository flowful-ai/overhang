import type { ThreadMessage } from "@assistant-ui/react";
import type { CadqueryToolResult } from "@/lib/cad-worker-protocol";
import { TOOL_NAME } from "../constants";

export interface CurrentDesign {
  // The CadQuery script behind the latest successful runCadquery tool call,
  // or "" if no successful render has occurred in this thread.
  currentCode: string;
  // base64 STL from the same tool call, or null when absent.
  currentStl: string | null;
  // The assistant message id that produced the current design. The UI uses
  // this to mark which tool-call card is the "live" one (editable editor +
  // active Re-render button).
  latestToolMessageId: string | null;
}

const EMPTY: CurrentDesign = {
  currentCode: "",
  currentStl: null,
  latestToolMessageId: null,
};

/**
 * Walk messages newest → oldest and return the first successful runCadquery
 * tool result. Pure; exported separately so tests can run without React
 * infrastructure.
 */
export function deriveCurrentDesign(messages: readonly ThreadMessage[]): CurrentDesign {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const part = m.content[j];
      if (part.type !== "tool-call" || part.toolName !== TOOL_NAME) continue;
      const result = part.result as CadqueryToolResult | undefined;
      if (result?.success && result.code) {
        return {
          currentCode: result.code,
          currentStl: result.stlBase64 ?? null,
          latestToolMessageId: m.id,
        };
      }
    }
  }
  return EMPTY;
}

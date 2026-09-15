import { TOOL_NAME } from "./constants";

// Within one assistant message the agent can render, fail, fix, and render
// again. A failed render that a later render in the same message replaced is
// "superseded": the chat collapses it into a compact row instead of a full
// error card, since the design did end up rendering (or is still trying).

export interface AttemptPart {
  type: string;
  toolName?: string;
  result?: unknown;
}

// Maps the content index of each superseded failed render call to its
// 1-based attempt number among the message's render calls.
export function findSupersededAttempts(parts: ReadonlyArray<AttemptPart>): Map<number, number> {
  const calls: number[] = [];
  parts.forEach((p, idx) => {
    if (p.type === "tool-call" && p.toolName === TOOL_NAME) calls.push(idx);
  });

  const superseded = new Map<number, number>();
  // The last call can never be superseded.
  for (let i = 0; i < calls.length - 1; i++) {
    const result = parts[calls[i]].result as { success?: boolean } | undefined;
    if (result && result.success === false) superseded.set(calls[i], i + 1);
  }
  return superseded;
}

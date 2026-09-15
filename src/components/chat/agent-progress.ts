import { TOOL_NAME, MAX_AGENT_STEPS } from "./constants";

// Derive a human progress label for the running agent turn from the streamed
// content parts of the last assistant message (UX audit #7). The agent loop is
// generate -> render -> (fix -> render)* so the parts tell us exactly where it
// is; no extra backend plumbing needed.

const MAX_STEPS = MAX_AGENT_STEPS;

export interface ProgressPart {
  type: string;
  toolName?: string;
  result?: unknown;
}

export function deriveAgentProgress(parts: ReadonlyArray<ProgressPart>): string {
  const toolCalls = parts.filter(
    (p) => p.type === "tool-call" && p.toolName === TOOL_NAME,
  );
  if (toolCalls.length === 0) return "Generating code...";

  const last = toolCalls[toolCalls.length - 1];
  const attempt = Math.min(toolCalls.length, MAX_STEPS);

  if (last.result === undefined) {
    // Tool input still streaming or the worker is rendering.
    return attempt === 1 ? "Rendering..." : `Rendering (attempt ${attempt} of ${MAX_STEPS})...`;
  }
  const result = last.result as { success?: boolean };
  if (result?.success === false) return "Fixing an issue...";
  // Last render succeeded; the model is writing its summary.
  return "Finishing up...";
}

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

function renderCalls(parts: ReadonlyArray<ProgressPart>): ProgressPart[] {
  return parts.filter((p) => p.type === "tool-call" && p.toolName === TOOL_NAME);
}

// The attempt number shows separately (deriveAgentStep), so the label only
// says what the agent is doing.
export function deriveAgentProgress(parts: ReadonlyArray<ProgressPart>): string {
  const toolCalls = renderCalls(parts);
  if (toolCalls.length === 0) return "Generating code...";

  const last = toolCalls[toolCalls.length - 1];

  if (last.result === undefined) {
    // Tool input still streaming or the worker is rendering.
    return "Rendering...";
  }
  const result = last.result as { success?: boolean };
  if (result?.success === false) return "Fixing an issue...";
  // Last render succeeded; the model is writing its summary.
  return "Finishing up...";
}

// The render step the turn is on, 1-based: the first render is step 1 even
// before its tool call streams in. Capped at the server's step budget.
export function deriveAgentStep(parts: ReadonlyArray<ProgressPart>): number {
  return Math.min(Math.max(renderCalls(parts).length, 1), MAX_STEPS);
}

// "8s", or "1m 05s" from a minute on.
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

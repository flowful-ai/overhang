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

// The agent step (one model call) the turn is on, 1-based. Each step ends in at
// most one render: while the newest render is pending the turn is still on its
// step; once it settled, the next step is underway (a fix, or the summary,
// which on the last step runs with tools off). Capped at the server's budget.
export function deriveAgentStep(parts: ReadonlyArray<ProgressPart>): number {
  const calls = renderCalls(parts);
  const last = calls[calls.length - 1];
  const step = last === undefined ? 1 : calls.length + (last.result === undefined ? 0 : 1);
  return Math.min(step, MAX_STEPS);
}

// True while the turn's newest render call has no result: its code is
// streaming in or the worker is rendering, so the mesh on screen is about to
// change. False for a text-only turn and once the render settled.
export function hasPendingRender(parts: ReadonlyArray<ProgressPart>): boolean {
  const calls = renderCalls(parts);
  return calls.length > 0 && calls[calls.length - 1].result === undefined;
}

// The text beside the running label: "Step 2 of 5 · 12s".
export function turnStatsLabel(parts: ReadonlyArray<ProgressPart>, elapsedSeconds: number): string {
  return `Step ${deriveAgentStep(parts)} of ${MAX_STEPS} · ${formatElapsed(elapsedSeconds)}`;
}

// "8s", or "1m 05s" from a minute on.
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

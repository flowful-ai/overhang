import { callCadWorker, type WorkerCallOptions } from "./cad-worker";
import { normalizePunctuation } from "./llm-code";
import { toSanitizedMessage } from "./sanitize-error";
import type { WorkerMetrics, WorkerRenderResult } from "./cad-worker-protocol";

// The one render pipeline, shared by the agent tool (runCadquery in
// cad-agent.ts, driven by the agent turn in agent-turn.ts) and the manual re-render route (/api/render-cad): normalize
// typographic punctuation the model/user may paste (Python's tokenizer rejects
// em-dashes, smart quotes, etc.), call the CAD worker, and return a structured
// success/failure result.
//
// Before, each caller went through the worker separately and only the agent
// path normalized, so the same code string healed via chat but SyntaxError'd on
// a manual re-render. This module is the single place that guarantees both
// paths normalize and see the same result shape.

export interface CadRenderSuccess {
  success: true;
  code: string; // normalized
  stlBase64: string;
  warnings: string[]; // Python emits null for "none"; coalesced to [] here.
  metrics: WorkerMetrics;
}

export interface CadRenderFailure {
  success: false;
  code: string; // normalized
  error: string; // sanitized (paths stripped), safe to show the user or model
  /**
   * The cad-worker's HTTP status when the failure came from a worker response
   * (400 = the code failed, 503 = load shed, ...). Undefined when the worker
   * was unreachable or timed out. Lets HTTP-facing callers classify the
   * failure instead of blanketing everything as one status.
   */
  workerStatus?: number;
}

export type CadRenderResult = CadRenderSuccess | CadRenderFailure;

/** The worker call renderCad drives: the live worker by default, a fake in tests and eval replay. */
export type RenderWorker = (
  code: string,
  requestId: string,
  options?: WorkerCallOptions,
) => Promise<WorkerRenderResult>;

// Backoff before each retry of a worker 503 (load shed: every render slot is
// taken). The busy state usually clears within a render or two; past that the
// failure goes back to the caller marked transient.
const BUSY_RETRY_DELAYS_MS = [500, 1500];

export const WORKER_BUSY_ERROR =
  "CAD worker is busy (transient infrastructure condition, not a problem with the code). Resend the same code unchanged.";

/** Resolves after `ms`, or early when `signal` aborts (the next worker call then fails fast on it). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function renderCad(
  code: string,
  requestId: string,
  // The eval replay path substitutes recorded worker responses; production uses
  // the live worker. `signal` cancels the worker call when the caller gives up.
  // `busyRetryDelaysMs` overrides the 503 backoff (tests).
  opts?: { callWorker?: RenderWorker; signal?: AbortSignal; busyRetryDelaysMs?: readonly number[] },
): Promise<CadRenderResult> {
  const callWorker = opts?.callWorker ?? callCadWorker;
  const delays = opts?.busyRetryDelaysMs ?? BUSY_RETRY_DELAYS_MS;
  const cleaned = normalizePunctuation(code);
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await callWorker(cleaned, requestId, { signal: opts?.signal });
      return {
        success: true,
        code: cleaned,
        stlBase64: data.stl_base64,
        warnings: data.warnings ?? [],
        metrics: data.metrics,
      };
    } catch (e: unknown) {
      const workerStatus = (e as { workerStatus?: unknown })?.workerStatus;
      // A 503 says nothing about the code. Returned as a plain failure, the
      // model "fixes" working code and burns steps, so retry it here first.
      if (workerStatus === 503) {
        if (attempt < delays.length && !opts?.signal?.aborted) {
          await pause(delays[attempt], opts?.signal);
          continue;
        }
        console.warn(`[${requestId}] cad-worker still busy after ${attempt + 1} attempts`);
        return { success: false, code: cleaned, error: WORKER_BUSY_ERROR, workerStatus };
      }
      if (process.env.NODE_ENV === "development") {
        console.error(`[${requestId}] cad-worker failed:`, cleaned.slice(0, 500));
      }
      return {
        success: false,
        code: cleaned,
        error: toSanitizedMessage(e),
        ...(typeof workerStatus === "number" ? { workerStatus } : {}),
      };
    }
  }
}

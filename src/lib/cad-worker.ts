import type { ZodType } from "zod";
import { APP_CONSTANTS } from "./utils";
import type { HttpStatusError } from "./http-error";
import { REQUEST_ID_HEADER } from "./sanitize-error";
import {
  WorkerRenderResult,
  WorkerThreeMFResult,
  type WorkerRenderResult as WorkerRenderResultT,
  type WorkerThreeMFResult as WorkerThreeMFResultT,
} from "./cad-worker-protocol";

export type { BoundingBox } from "./cad-worker-protocol";

const CAD_WORKER_URL = process.env.CAD_WORKER_URL || "http://localhost:8000";

const WORKER_SECRET = process.env.WORKER_SECRET;

/**
 * Error thrown by callWorker. `workerStatus` is the worker's HTTP status when
 * there was a response at all; `httpStatus` is the status OUR route should
 * return, resolved at throw time so withRoute's generic catch can honour it
 * without knowing anything about the CAD worker (see HttpStatusError).
 */
export interface WorkerCallError extends HttpStatusError {
  workerStatus?: number;
}

function workerError(message: string, workerStatus?: number): WorkerCallError {
  const err = new Error(message) as WorkerCallError;
  if (workerStatus !== undefined) err.workerStatus = workerStatus;
  err.httpStatus = httpStatusForWorkerFailure(workerStatus);
  return err;
}

/**
 * Options for a worker call. `signal` is the caller's abort (the agent turn
 * passes its composed client-disconnect + turn-timeout signal); it is combined
 * with the call's own `timeoutMs`, so whichever fires first cancels the fetch.
 */
export interface WorkerCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function callWorker<T>(
  path: string,
  code: string,
  requestId: string,
  schema: ZodType<T>,
  { timeoutMs = 60_000, signal }: WorkerCallOptions = {},
): Promise<T> {
  if (code.length > APP_CONSTANTS.MAX_CODE_LENGTH) {
    throw new Error(`Code exceeds maximum length of ${APP_CONSTANTS.MAX_CODE_LENGTH.toLocaleString()} characters`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  // Shared secret with the cad-worker. Without this, anything reachable on
  // the docker network could POST arbitrary CadQuery code. Header is dropped
  // (not sent as empty) when WORKER_SECRET is unset, so the worker's "no
  // secret configured" branch keeps working for local dev.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [REQUEST_ID_HEADER]: requestId,
  };
  if (WORKER_SECRET) {
    headers["X-Worker-Secret"] = WORKER_SECRET;
  }

  let response: Response;
  try {
    response = await fetch(`${CAD_WORKER_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code }),
      signal: fetchSignal,
    });
  } catch (e: unknown) {
    // The caller gave up (client disconnect, turn timeout): not a worker fault.
    if (signal?.aborted) {
      throw workerError("CAD worker request aborted");
    }
    if (e instanceof Error && e.name === "AbortError") {
      throw workerError("CAD worker timed out");
    }
    throw workerError("Failed to connect to CAD worker. Is it running?");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.detail || raw;
    } catch {
      // raw text is fine
    }
    throw workerError(`CAD Rendering Failed: ${detail}`, response.status);
  }

  // Validate at the seam instead of casting. A drift on the Python side
  // (renamed field, added field, wrong nullability) fails here with a
  // specific message rather than crashing the caller with "cannot read
  // property 'x' of undefined" two function calls deeper.
  const json: unknown = await response.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? issue.path.join(".") : "<root>";
    throw workerError(`CAD worker returned an unexpected response shape at ${where}: ${issue?.message ?? "unknown"}`);
  }
  return parsed.data;
}

/**
 * Map a worker failure to the HTTP status our routes should return. One
 * policy for every worker-backed route (render-cad uses it directly on
 * renderCad's failure result; withRoute's catch applies it to thrown errors
 * carrying workerStatus, which covers export-3mf): the worker's 4xx means the
 * USER's code failed (client error — a typo in the editor must not pollute
 * server-fault monitoring), the worker's 503 load-shed passes through as
 * retryable, and everything else — unreachable, timeout, worker 5xx, schema
 * drift — is an upstream fault that must stay visible to 5xx alerting.
 */
export function httpStatusForWorkerFailure(workerStatus: number | undefined): number {
  if (workerStatus === undefined) return 502;
  if (workerStatus === 503) return 503;
  return workerStatus < 500 ? 400 : 502;
}

/**
 * Liveness probe for the CAD worker's /health endpoint. Returns true only if
 * the worker answers OK within `timeoutMs`. Used to fail fast before opening a
 * paid LLM stream (so an outage doesn't cost ~5x the tokens for zero output)
 * and by /api/health?deep=1. Never throws.
 */
export async function pingCadWorker(timeoutMs = 2000): Promise<boolean> {
  try {
    const r = await fetch(`${CAD_WORKER_URL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Render CadQuery code to STL. Used by the live viewer pipeline.
 */
export function callCadWorker(
  code: string,
  requestId: string,
  options?: WorkerCallOptions,
): Promise<WorkerRenderResultT> {
  return callWorker("/render", code, requestId, WorkerRenderResult, options);
}

/**
 * Export CadQuery code to 3MF. Called on-demand for downloads only.
 */
export function exportThreeMF(code: string, requestId: string, timeoutMs = 60_000): Promise<WorkerThreeMFResultT> {
  return callWorker("/export-3mf", code, requestId, WorkerThreeMFResult, { timeoutMs });
}

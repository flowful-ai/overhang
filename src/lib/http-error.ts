/**
 * The one channel by which a thrown error tells an HTTP route what status to
 * return. `withRoute`'s catch (src/lib/api-handler.ts) reads `httpStatus` and
 * falls back to 500, so a subsystem can classify its own failures without the
 * shared handler learning that subsystem's error shape.
 *
 * Set it where the error is constructed, next to the knowledge that justifies
 * it — see `workerError` in cad-worker.ts, which maps the CAD worker's
 * response status onto ours.
 */
export interface HttpStatusError extends Error {
  httpStatus: number;
}

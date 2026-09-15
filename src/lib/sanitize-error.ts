/**
 * Strip absolute filesystem paths from error text before showing it to the
 * user or sending it to the LLM. CadQuery/OCC errors routinely include the
 * conda env path which is noise to the model and a minor info leak.
 *
 * Keep the regex in sync with `sanitize_error` in cad-worker/main.py.
 */
export function sanitizeError(s: string): string {
  return s.replace(/(?:\/[\w.\-]+)+(?:\.py|\.so|\.cpp|\.h)?/g, "<path>");
}

export function toSanitizedMessage(e: unknown): string {
  return sanitizeError(e instanceof Error ? e.message : String(e));
}

export const REQUEST_ID_HEADER = "X-Request-Id";

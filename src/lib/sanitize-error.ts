/**
 * Strip absolute filesystem paths from error text before showing it to the
 * user or sending it to the LLM. CadQuery/OCC errors routinely include the
 * conda env path which is noise to the model and a minor info leak.
 *
 * Absolute paths only: the path must not follow a word character, `.`, `)`
 * or `]`, and needs at least two segments. Otherwise the model's own
 * arithmetic (`width/2`, `(a + b)/2`, `x /2`) is mangled into `width<path>` in
 * the error it has to fix.
 *
 * Keep the regex in sync with `sanitize_error` in cad-worker/main.py.
 */
export function sanitizeError(s: string): string {
  return s.replace(/(?<![\w.)\]])(?:\/[\w.\-]+){2,}(?:\.py|\.so|\.cpp|\.h)?/g, "<path>");
}

export function toSanitizedMessage(e: unknown): string {
  return sanitizeError(e instanceof Error ? e.message : String(e));
}

export const REQUEST_ID_HEADER = "X-Request-Id";

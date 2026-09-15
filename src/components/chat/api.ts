// Shared client-side POST helper for the app's JSON API routes. Every route is
// wrapped by withRoute (src/lib/api-handler.ts), which returns `{ error }` on
// failure, so the failure branch here mirrors that contract: surface the
// server's message, falling back to the response body text, then a caller-
// supplied default.
export async function postJson<T>(
  path: string,
  body: unknown,
  fallbackMessage = "Request failed",
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Read the body exactly once: a Response stream is single-use, so calling
    // .json() and then .text() on a non-JSON error body throws "body already
    // consumed" and masks the real error. Read text, then try to parse it.
    const raw = await response.text();
    let message = fallbackMessage;
    try {
      message = JSON.parse(raw).error || raw || fallbackMessage;
    } catch {
      message = raw || fallbackMessage;
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

// Turns a failed agent turn into copy a user can act on. The AI SDK chat
// transport throws `new Error(await response.text())`, so the thread only ever
// sees the raw response body (e.g. `{"error":"Too many requests..."}`) with no
// status code. The server's JSON error contract (src/lib/api-handler.ts,
// src/lib/in-flight.ts, src/app/api/generate-cad/route.ts) is matched on its
// message text instead. Pure; unit-tested in chat-error.test.ts.

export interface ChatErrorInfo {
  message: string;
  // False when resending the same request cannot succeed (validation, payload
  // size): the Retry button is hidden.
  retryable: boolean;
}

const MAX_RAW_LENGTH = 300;

// The server's `error` field when the body is `{"error": string}`, otherwise
// the raw text. Accepts whatever the runtime stored as the status error.
export function extractErrorText(err: unknown): string {
  let raw = "";
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    raw = (err as { message: string }).message;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const error = (parsed as { error?: unknown } | null)?.error;
      if (typeof error === "string" && error.trim()) return error.trim();
    } catch {
      // Not JSON after all: fall through to the raw text.
    }
  }
  return trimmed;
}

// First match wins, so specific rules precede the generic ones they overlap
// (the image size cap before the request body cap).
const RULES: { test: RegExp; info: ChatErrorInfo }[] = [
  // 400: a single snapshot over the server's image cap.
  {
    test: /image attachment too large/i,
    info: {
      message: "The snapshot is too large to send. Remove it, or take a new one from a smaller viewer window.",
      retryable: false,
    },
  },
  // 400: prompt length cap.
  {
    test: /prompt exceeds maximum length/i,
    info: { message: "Your message is too long. Shorten it and send again.", retryable: false },
  },
  // 400: non-inline attachment.
  {
    test: /only inline image attachments/i,
    info: {
      message: "Only snapshots taken in the viewer can be attached. Remove the attachment and send again.",
      retryable: false,
    },
  },
  // 400: history rejected by the message validator, role filter, or request schema.
  {
    test: /invalid message format|only user and assistant messages|^invalid request$/i,
    info: { message: "This conversation couldn't be sent. Start a new chat to continue.", retryable: false },
  },
  // 429 from withRoute's rate limiter.
  {
    test: /too many requests/i,
    info: { message: "Too many requests. Wait a few seconds, then retry.", retryable: true },
  },
  // 503 from the generation pool.
  {
    test: /overhang is busy/i,
    info: { message: "Overhang is busy right now. Retry in a moment.", retryable: true },
  },
  // 503 kill switch, CAD engine down, or an overloaded upstream.
  {
    test: /temporarily (disabled|unavailable)|service unavailable|overloaded/i,
    info: { message: "Generation is temporarily unavailable. Try again in a few minutes.", retryable: true },
  },
  // 413 body cap.
  {
    test: /too large/i,
    info: { message: "This conversation is too large to send. Start a new chat to continue.", retryable: false },
  },
  // fetch() rejections: Chrome, Firefox, Safari, React Native wording.
  {
    test: /failed to fetch|networkerror|network error|load failed|network request failed/i,
    info: { message: "Network error. Check your connection, then retry.", retryable: true },
  },
];

export function describeChatError(err: unknown): ChatErrorInfo {
  const text = extractErrorText(err);
  if (!text) return { message: "Something went wrong. Please retry.", retryable: true };
  for (const rule of RULES) {
    if (rule.test.test(text)) return rule.info;
  }
  // An HTML error page from a proxy is noise, not a message.
  if (text.startsWith("<")) {
    return { message: "The server returned an unexpected response. Please retry.", retryable: true };
  }
  return {
    message: text.length > MAX_RAW_LENGTH ? `${text.slice(0, MAX_RAW_LENGTH)}...` : text,
    retryable: true,
  };
}

interface RetryableMessage {
  id: string;
  role: string;
  status?: { type: string; reason?: string };
}

// The user message to resend when the thread ended on a failed assistant turn,
// or null when there is nothing to retry. Retrying passes this id as the run's
// parentId: the AI SDK runtime slices the thread back to it (dropping the failed
// assistant message) and regenerates.
export function findRetryTarget(messages: readonly RetryableMessage[], isRunning: boolean): string | null {
  if (isRunning) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  if (last.status?.type !== "incomplete" || last.status.reason !== "error") return null;
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return null;
}

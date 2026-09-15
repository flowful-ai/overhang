import { describe, it, expect } from "vitest";
import { describeChatError, extractErrorText, findRetryTarget, isBusyError } from "@/components/chat/chat-error";

describe("extractErrorText", () => {
  it("parses the `error` field from a JSON body", () => {
    expect(extractErrorText(new Error('{"error":"Too many requests. Please wait a moment."}'))).toBe(
      "Too many requests. Please wait a moment.",
    );
  });

  it("falls back to the raw text for non-JSON or JSON without `error`", () => {
    expect(extractErrorText(new Error("Upstream exploded"))).toBe("Upstream exploded");
    expect(extractErrorText('{"message":"nope"}')).toBe('{"message":"nope"}');
    expect(extractErrorText("{not json")).toBe("{not json");
  });

  it("accepts strings, error-like objects, and junk", () => {
    expect(extractErrorText("  plain  ")).toBe("plain");
    expect(extractErrorText({ message: "obj" })).toBe("obj");
    expect(extractErrorText(undefined)).toBe("");
    expect(extractErrorText(42)).toBe("");
  });
});

describe("describeChatError", () => {
  const body = (error: string) => new Error(JSON.stringify({ error }));

  it("maps the server's turn timeout", () => {
    const info = describeChatError(new Error("The operation was aborted due to timeout"));
    expect(info).toEqual({
      message: "This reply took too long and was stopped. Retry, or ask for a smaller change.",
      retryable: true,
    });
  });

  it("recognizes the busy 503", () => {
    expect(isBusyError(body("Overhang is busy right now. Please try again in a moment."))).toBe(true);
    expect(isBusyError(body("Too many requests. Please wait a moment."))).toBe(false);
  });

  it("maps the rate limiter 429", () => {
    const info = describeChatError(body("Too many requests. Please wait a moment."));
    expect(info).toEqual({ message: "Too many requests. Wait a few seconds, then retry.", retryable: true });
  });

  it("maps the 503 kill switch", () => {
    const info = describeChatError(body("This endpoint is temporarily disabled. Please try again later."));
    expect(info).toEqual({ message: "Generation is temporarily unavailable. Try again in a few minutes.", retryable: true });
  });

  it("maps 413 as not retryable", () => {
    const info = describeChatError(body("Request body too large (123 > 100 bytes)."));
    expect(info.retryable).toBe(false);
    expect(info.message).toMatch(/too large/);
  });

  it("gives an oversized snapshot its own non-retryable copy", () => {
    const info = describeChatError(body("Image attachment too large (max 2 MB)."));
    expect(info.retryable).toBe(false);
    expect(info.message).toMatch(/snapshot is too large/);
    expect(info.message).not.toMatch(/conversation/);
  });

  it("maps the 413 body cap from the hardened handler wording", () => {
    const info = describeChatError(body("Request body too large (limit 4194304 bytes)."));
    expect(info).toEqual({ message: "This conversation is too large to send. Start a new chat to continue.", retryable: false });
  });

  it("maps the prompt length 400 as not retryable", () => {
    const info = describeChatError(body("Prompt exceeds maximum length of 10,000 characters."));
    expect(info).toEqual({ message: "Your message is too long. Shorten it and send again.", retryable: false });
  });

  it.each([
    "Invalid message format.",
    "Invalid message format: bad part",
    "Only user and assistant messages are accepted.",
    "Invalid request",
  ])(
    "maps validation 400 %j as not retryable",
    (msg) => {
      expect(describeChatError(body(msg))).toEqual({
        message: "This conversation couldn't be sent. Start a new chat to continue.",
        retryable: false,
      });
    },
  );

  it("maps the non-inline attachment 400 as not retryable", () => {
    const info = describeChatError(body("Only inline image attachments are supported."));
    expect(info.retryable).toBe(false);
    expect(info.message).toMatch(/snapshots taken in the viewer/);
  });

  it("maps the generation pool 503 as retryable", () => {
    expect(describeChatError(body("Overhang is busy right now. Please try again in a moment."))).toEqual({
      message: "Overhang is busy right now. Retry in a moment.",
      retryable: true,
    });
  });

  it("maps the CAD engine 503 as retryable", () => {
    const info = describeChatError(body("The CAD engine is temporarily unavailable. Please try again in a moment."));
    expect(info.retryable).toBe(true);
    expect(info.message).toMatch(/temporarily unavailable/);
  });

  it.each(["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])(
    "maps network failure %j",
    (msg) => {
      const err = new TypeError(msg);
      expect(describeChatError(err)).toEqual({ message: "Network error. Check your connection, then retry.", retryable: true });
    },
  );

  it("shows the server message when it matches no rule", () => {
    expect(describeChatError(body("Model refused the request"))).toEqual({ message: "Model refused the request", retryable: true });
  });

  it("hides HTML error pages and truncates long text", () => {
    expect(describeChatError(new Error("<html><body>502 Bad Gateway</body></html>")).message).toMatch(/unexpected response/);
    const long = describeChatError(new Error("x".repeat(1000))).message;
    expect(long.length).toBeLessThanOrEqual(303);
    expect(long.endsWith("...")).toBe(true);
  });

  it("has a generic message for empty errors", () => {
    expect(describeChatError(undefined)).toEqual({ message: "Something went wrong. Please retry.", retryable: true });
  });
});

describe("findRetryTarget", () => {
  const user = (id: string) => ({ id, role: "user" });
  const ok = (id: string) => ({ id, role: "assistant", status: { type: "complete", reason: "stop" } });
  const failed = (id: string) => ({ id, role: "assistant", status: { type: "incomplete", reason: "error" } });

  it("returns the last user message when the thread ends on a failed turn", () => {
    expect(findRetryTarget([user("u1"), ok("a1"), user("u2"), failed("a2")], false)).toBe("u2");
  });

  it("returns null while running", () => {
    expect(findRetryTarget([user("u1"), failed("a1")], true)).toBeNull();
  });

  it("returns null when the last turn succeeded or was cancelled", () => {
    expect(findRetryTarget([user("u1"), ok("a1")], false)).toBeNull();
    expect(
      findRetryTarget([user("u1"), { id: "a1", role: "assistant", status: { type: "incomplete", reason: "cancelled" } }], false),
    ).toBeNull();
  });

  it("returns null for an older failure followed by a later turn", () => {
    expect(findRetryTarget([user("u1"), failed("a1"), user("u2"), ok("a2")], false)).toBeNull();
  });

  it("returns null for an empty thread or no user message", () => {
    expect(findRetryTarget([], false)).toBeNull();
    expect(findRetryTarget([failed("a1")], false)).toBeNull();
  });
});

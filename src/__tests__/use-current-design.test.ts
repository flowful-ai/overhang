import { describe, it, expect } from "vitest";
import { deriveCurrentDesign } from "@/components/chat/hooks/use-current-design";
import type { ThreadMessage } from "@assistant-ui/react";

// Minimal builders. We cast through unknown because the assistant-ui types
// are large and irrelevant for the logic under test (a thread walker).
function assistantToolCall(
  id: string,
  toolName: string,
  result: unknown,
): ThreadMessage {
  return {
    id,
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: `${id}-tc`,
        toolName,
        args: {},
        result,
      },
    ],
  } as unknown as ThreadMessage;
}

function userMessage(id: string, text: string): ThreadMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
  } as unknown as ThreadMessage;
}

const success = (code: string, stl: string) => ({
  success: true,
  code,
  stlBase64: stl,
  warnings: [],
  metrics: { bbox: { x: 1, y: 1, z: 1 }, volume: 1 },
  summary: "ok",
});

const failure = (code: string, error: string) => ({
  success: false,
  code,
  error,
});

describe("deriveCurrentDesign", () => {
  it("returns the empty design for an empty thread", () => {
    expect(deriveCurrentDesign([])).toEqual({
      currentCode: "",
      currentStl: null,
      latestToolMessageId: null,
    });
  });

  it("returns the latest successful render", () => {
    const thread: ThreadMessage[] = [
      userMessage("u1", "make a cube"),
      assistantToolCall("a1", "runCadquery", success("box(10)", "STL1")),
    ];
    expect(deriveCurrentDesign(thread)).toEqual({
      currentCode: "box(10)",
      currentStl: "STL1",
      latestToolMessageId: "a1",
    });
  });

  it("walks newest → oldest and returns the most recent success", () => {
    const thread: ThreadMessage[] = [
      assistantToolCall("a1", "runCadquery", success("box(5)", "STL_OLD")),
      userMessage("u2", "make it bigger"),
      assistantToolCall("a2", "runCadquery", success("box(20)", "STL_NEW")),
    ];
    const out = deriveCurrentDesign(thread);
    expect(out.currentCode).toBe("box(20)");
    expect(out.currentStl).toBe("STL_NEW");
    expect(out.latestToolMessageId).toBe("a2");
  });

  it("skips a later failure and falls back to the prior success", () => {
    const thread: ThreadMessage[] = [
      assistantToolCall("a1", "runCadquery", success("box(5)", "STL_OK")),
      userMessage("u2", "now break it"),
      assistantToolCall("a2", "runCadquery", failure("broken = ?", "SyntaxError")),
    ];
    const out = deriveCurrentDesign(thread);
    expect(out.currentCode).toBe("box(5)");
    expect(out.currentStl).toBe("STL_OK");
    expect(out.latestToolMessageId).toBe("a1");
  });

  it("ignores tool calls for other tools", () => {
    const thread: ThreadMessage[] = [
      assistantToolCall("a1", "someOtherTool", { irrelevant: true }),
    ];
    expect(deriveCurrentDesign(thread)).toEqual({
      currentCode: "",
      currentStl: null,
      latestToolMessageId: null,
    });
  });

  it("ignores in-flight tool calls (no result yet)", () => {
    const thread: ThreadMessage[] = [
      assistantToolCall("a1", "runCadquery", undefined),
    ];
    expect(deriveCurrentDesign(thread).currentCode).toBe("");
  });

  it("returns null currentStl when the success result lacks stlBase64", () => {
    // Schema requires stlBase64 on success, but the hook should still cope if
    // it's missing (e.g. older persisted thread). currentCode is still set.
    const partialSuccess = { success: true, code: "box(1)" } as unknown;
    const thread: ThreadMessage[] = [
      assistantToolCall("a1", "runCadquery", partialSuccess),
    ];
    const out = deriveCurrentDesign(thread);
    expect(out.currentCode).toBe("box(1)");
    expect(out.currentStl).toBeNull();
  });
});

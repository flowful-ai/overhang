import { describe, it, expect } from "vitest";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { forNextTurn } from "@/components/chat/next-turn";
import { prepareForStorage, toRepository } from "@/components/chat/persisted-state";
import { TOOL_NAME } from "@/components/chat/constants";
import { OMITTED_SNAPSHOT_TEXT } from "@/components/chat/strip-images";

// Locks the client's outgoing and stored message shape to what the server's
// validator (safeValidateUIMessages in the generate-cad route) accepts.
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

const thread = [
  {
    id: "u1",
    role: "user",
    // assistant-ui labels every image part image/png.
    parts: [{ type: "text", text: "make a box" }, { type: "file", url: JPEG, mediaType: "image/png" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "Here is a box." },
      {
        type: `tool-${TOOL_NAME}`,
        toolCallId: "call-1",
        state: "output-available",
        input: { code: "result = cq.Workplane().box(10, 10, 10)" },
        output: { success: true, code: "result = cq.Workplane().box(10, 10, 10)", stlBase64: "U1RM", warnings: [] },
      },
    ],
  },
  {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "make it thinner" }, { type: "file", url: JPEG, mediaType: "image/png" }],
  },
] as unknown as UIMessage[];

type Part = Record<string, unknown>;

describe("message shape compatibility", () => {
  it("forNextTurn output passes safeValidateUIMessages", async () => {
    const out = forNextTurn(thread, "result = cq.Workplane().box(10, 10, 5)");
    const result = await safeValidateUIMessages({ messages: out });
    if (!result.success) throw result.error;

    const [older, , latest] = result.data;
    expect(older.parts as unknown as Part[]).toContainEqual({ type: "text", text: OMITTED_SNAPSHOT_TEXT });
    expect((older.parts as unknown as Part[]).some((p) => p.type === "file")).toBe(false);
    expect(latest.parts as unknown as Part[]).toContainEqual({ type: "file", url: JPEG, mediaType: "image/jpeg" });
  });

  it("the stored thread passes safeValidateUIMessages after a JSON round trip", async () => {
    const stored = JSON.parse(JSON.stringify(prepareForStorage(toRepository(thread)!)));
    const result = await safeValidateUIMessages({
      messages: (stored.messages as { message: UIMessage }[]).map((m) => m.message),
    });
    expect(result.success).toBe(true);
  });

  it("keeps the placeholder text byte-identical (the server exempts it from the prompt cap)", () => {
    expect(OMITTED_SNAPSHOT_TEXT).toBe("[Snapshot omitted from history]");
  });
});

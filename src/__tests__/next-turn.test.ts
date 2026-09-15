import { describe, it, expect } from "vitest";
import { forNextTurn } from "@/components/chat/next-turn";
import { TOOL_NAME } from "@/components/chat/constants";
import type { UIMessage } from "ai";

// Minimal fixtures in the UIMessage transport shape: a runCadquery tool part
// carries its result in `output`. We cast loosely because the code treats parts
// as records, matching stripStlFromMessages.
type Part = Record<string, unknown>;
const toolPart = (code: string, success = true, stl: string | null = "STLDATA"): Part => ({
  type: `tool-${TOOL_NAME}`,
  toolCallId: "call-" + code,
  output: {
    success,
    code,
    stlBase64: stl,
    warnings: ["Thin walls detected"],
    metrics: { bbox: { x: 1, y: 2, z: 3 }, volume: 6 },
    summary: "Render OK. Bounding box: 1.0x2.0x3.0mm.",
  },
});
const toolMsg = (id: string, code: string, success = true, stl: string | null = "STLDATA") =>
  ({ id, role: "assistant", parts: [{ type: "text", text: "ok" }, toolPart(code, success, stl)] } as unknown as UIMessage);
const userMsg = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] } as unknown as UIMessage);

const partOf = (m: UIMessage) =>
  (m.parts as unknown as Part[]).find((p) => p.type === `tool-${TOOL_NAME}`)!.output as {
    code?: string;
    stlBase64?: string;
    summary?: string;
    metrics?: unknown;
    warnings?: unknown;
  };

describe("forNextTurn", () => {
  it("patches the latest successful tool code with a modified working copy", () => {
    const out = forNextTurn([userMsg("u1", "make a box"), toolMsg("a1", "BOX_ORIGINAL")], "BOX_EDITED");
    expect(partOf(out[1]).code).toBe("BOX_EDITED");
  });

  it("neutralizes stale summary/metrics/warnings when patching the code", () => {
    // The recorded render described the PRE-edit geometry; leaving its bbox
    // summary and warnings attached would mislead the agent about the basis.
    const out = forNextTurn([toolMsg("a1", "ORIG")], "EDITED");
    const patched = partOf(out[0]);
    expect(patched.code).toBe("EDITED");
    expect(patched.metrics).toBeUndefined();
    expect(patched.warnings).toBeUndefined();
    expect(patched.summary).toMatch(/edited/i);
    expect(patched.summary).not.toMatch(/Bounding box/);
  });

  it("keeps summary/metrics/warnings intact when nothing is patched", () => {
    const out = forNextTurn([toolMsg("a1", "SAME")], "SAME");
    const untouched = partOf(out[0]);
    expect(untouched.metrics).toEqual({ bbox: { x: 1, y: 2, z: 3 }, volume: 6 });
    expect(untouched.summary).toMatch(/Bounding box/);
  });

  it("strips stlBase64 from tool output", () => {
    const out = forNextTurn([toolMsg("a1", "C")], "C");
    expect(partOf(out[0]).stlBase64).toBeUndefined();
    expect(partOf(out[0]).code).toBe("C");
  });

  it("leaves the code unpatched when the working copy is empty", () => {
    const out = forNextTurn([toolMsg("a1", "ORIG")], "");
    expect(partOf(out[0]).code).toBe("ORIG");
  });

  it("leaves the code unpatched when the working copy equals the current code", () => {
    const out = forNextTurn([toolMsg("a1", "SAME")], "SAME");
    expect(partOf(out[0]).code).toBe("SAME");
  });

  it("only patches the newest successful tool call", () => {
    const out = forNextTurn([toolMsg("a1", "OLD"), userMsg("u2", "again"), toolMsg("a2", "NEW")], "EDITED");
    expect(partOf(out[0]).code).toBe("OLD");
    expect(partOf(out[2]).code).toBe("EDITED");
  });

  it("patches the latest *successful* call, skipping a newer failed one", () => {
    const out = forNextTurn([toolMsg("a1", "GOOD"), toolMsg("a2", "BAD", false)], "EDITED");
    expect(partOf(out[0]).code).toBe("EDITED");
    expect(partOf(out[1]).code).toBe("BAD");
  });

  it("passes through (strip only) when there is no tool call", () => {
    const out = forNextTurn([userMsg("u1", "hi")], "WHATEVER");
    expect((out[0].parts as unknown as Part[])[0].text).toBe("hi");
  });

  it("does not mutate the input messages", () => {
    const msgs = [toolMsg("a1", "ORIG")];
    const snapshot = JSON.stringify(msgs);
    forNextTurn(msgs, "EDITED");
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });
});

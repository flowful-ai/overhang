import { describe, expect, it } from "vitest";
import { findSupersededAttempts } from "@/components/chat/tool-attempts";
import { TOOL_NAME } from "@/components/chat/constants";

const call = (result?: unknown) => ({ type: "tool-call", toolName: TOOL_NAME, result });
const failed = call({ success: false, error: "boom" });
const ok = call({ success: true });
const running = call();
const text = { type: "text" };
const reasoning = { type: "reasoning" };

const entries = (parts: Parameters<typeof findSupersededAttempts>[0]) =>
  [...findSupersededAttempts(parts).entries()];

describe("findSupersededAttempts", () => {
  it("returns nothing for an empty message", () => {
    expect(entries([])).toEqual([]);
  });

  it("does not supersede a single failure", () => {
    expect(entries([failed])).toEqual([]);
  });

  it("supersedes a failure followed by a success", () => {
    expect(entries([failed, ok])).toEqual([[0, 1]]);
  });

  it("supersedes two failures followed by a success", () => {
    expect(entries([failed, failed, ok])).toEqual([[0, 1], [1, 2]]);
  });

  it("supersedes a failure followed by an in-progress call", () => {
    expect(entries([failed, running])).toEqual([[0, 1]]);
  });

  it("keeps a failure that is the last call after an earlier success", () => {
    expect(entries([ok, failed])).toEqual([]);
  });

  it("keeps the last failure when every call failed", () => {
    expect(entries([failed, failed])).toEqual([[0, 1]]);
  });

  it("uses content indices and render-call attempt numbers with other parts interleaved", () => {
    const parts = [
      reasoning,
      text,
      failed,
      text,
      { type: "tool-call", toolName: "otherTool", result: { success: false } },
      reasoning,
      failed,
      text,
      ok,
      text,
    ];
    expect(entries(parts)).toEqual([[2, 1], [6, 2]]);
  });

  it("ignores failures from other tools", () => {
    expect(entries([{ type: "tool-call", toolName: "otherTool", result: { success: false } }, ok])).toEqual([]);
  });
});

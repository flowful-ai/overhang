import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/cad-agent";

// The final text-only step itself is tested at the agent turn interface
// (agent-turn.test.ts).

describe("SYSTEM_PROMPT", () => {
  it("points the model at the latest successful tool RESULT code, which carries user edits", () => {
    // next-turn.ts writes the user's edited script into the tool result's
    // `code` field, not into the tool call input.
    expect(SYSTEM_PROMPT).toMatch(/`code` field of the most recent successful `runCadquery` tool RESULT/);
    expect(SYSTEM_PROMPT).not.toMatch(/last `runCadquery` tool call in the conversation contains/);
  });

  it("tells the model the final step has tools disabled", () => {
    expect(SYSTEM_PROMPT).toContain(`last step has tools disabled`);
  });
});

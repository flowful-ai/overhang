import { describe, expect, it } from "vitest";
import { deriveAgentProgress } from "@/components/chat/agent-progress";
import { TOOL_NAME } from "@/components/chat/constants";

const call = (result?: unknown) => ({ type: "tool-call", toolName: TOOL_NAME, result });
const text = { type: "text" };

describe("deriveAgentProgress", () => {
  it("reports generating before any tool call", () => {
    expect(deriveAgentProgress([])).toBe("Generating code...");
    expect(deriveAgentProgress([text])).toBe("Generating code...");
  });

  it("ignores tool calls from other tools", () => {
    expect(deriveAgentProgress([{ type: "tool-call", toolName: "other" }])).toBe(
      "Generating code...",
    );
  });

  it("reports rendering while the first call has no result", () => {
    expect(deriveAgentProgress([call()])).toBe("Rendering...");
  });

  it("reports fixing after a failed render", () => {
    expect(deriveAgentProgress([call({ success: false })])).toBe("Fixing an issue...");
  });

  it("reports retry attempt while a later call renders", () => {
    expect(deriveAgentProgress([call({ success: false }), call()])).toBe(
      "Rendering (attempt 2 of 5)...",
    );
  });

  it("reports finishing after a successful render", () => {
    expect(deriveAgentProgress([call({ success: true })])).toBe("Finishing up...");
    expect(deriveAgentProgress([call({ success: false }), call({ success: true })])).toBe(
      "Finishing up...",
    );
  });

  it("caps the attempt counter at the step budget", () => {
    const parts = [
      call({ success: false }),
      call({ success: false }),
      call({ success: false }),
      call({ success: false }),
      call({ success: false }),
      call(),
    ];
    expect(deriveAgentProgress(parts)).toBe("Rendering (attempt 5 of 5)...");
  });
});

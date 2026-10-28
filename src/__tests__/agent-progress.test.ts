import { describe, expect, it } from "vitest";
import { deriveAgentProgress, deriveAgentStep, formatElapsed } from "@/components/chat/agent-progress";
import { MAX_AGENT_STEPS, TOOL_NAME } from "@/components/chat/constants";

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

  it("reports rendering while a later call renders (the step shows separately)", () => {
    expect(deriveAgentProgress([call({ success: false }), call()])).toBe("Rendering...");
  });

  it("reports finishing after a successful render", () => {
    expect(deriveAgentProgress([call({ success: true })])).toBe("Finishing up...");
    expect(deriveAgentProgress([call({ success: false }), call({ success: true })])).toBe(
      "Finishing up...",
    );
  });

});

describe("deriveAgentStep", () => {
  it("is step 1 before and during the first render", () => {
    expect(deriveAgentStep([])).toBe(1);
    expect(deriveAgentStep([text])).toBe(1);
    expect(deriveAgentStep([call()])).toBe(1);
    expect(deriveAgentStep([call({ success: false })])).toBe(1);
  });

  it("counts render calls only", () => {
    expect(deriveAgentStep([call({ success: false }), text, call()])).toBe(2);
    expect(deriveAgentStep([call({ success: false }), { type: "tool-call", toolName: "other" }])).toBe(1);
  });

  it("caps the step at the step budget", () => {
    const parts = Array.from({ length: MAX_AGENT_STEPS + 1 }, () => call({ success: false }));
    expect(deriveAgentStep(parts)).toBe(MAX_AGENT_STEPS);
  });
});

describe("formatElapsed", () => {
  it("shows seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59)).toBe("59s");
  });

  it("shows minutes and padded seconds from a minute on", () => {
    expect(formatElapsed(60)).toBe("1m 00s");
    expect(formatElapsed(125)).toBe("2m 05s");
  });

  it("clamps negative and fractional input", () => {
    expect(formatElapsed(-3)).toBe("0s");
    expect(formatElapsed(7.9)).toBe("7s");
  });
});

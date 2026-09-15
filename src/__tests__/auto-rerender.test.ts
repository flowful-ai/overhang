import { describe, it, expect } from "vitest";
import { stepAutoRerender, type AutoRerenderInput } from "@/components/chat/auto-rerender";

const restored: AutoRerenderInput = { needsRerender: true, hasStl: false, isRendering: false, currentCode: "box()" };

// Drives stepAutoRerender the way the design session's effect does: one step
// per commit, threading attemptedCode through, counting renders fired.
function simulate(commits: AutoRerenderInput[], initialAttempted: string | null = null) {
  let attempted = initialAttempted;
  let fired = 0;
  for (const input of commits) {
    const step = stepAutoRerender(input, attempted);
    attempted = step.attemptedCode;
    if (step.fire) fired++;
  }
  return { fired, attempted };
}

describe("stepAutoRerender", () => {
  it("fires once for a restored thread and records the attempt", () => {
    expect(stepAutoRerender(restored, null)).toEqual({ fire: true, attemptedCode: "box()" });
  });

  it("fires once per code and does not loop after a failed render", () => {
    const { fired } = simulate([
      restored, // effect fires
      { ...restored, isRendering: true }, // request in flight
      restored, // failed: still no STL, not rendering
      restored,
      restored,
    ]);
    expect(fired).toBe(1);
  });

  it("does not fire again when the user edits the working copy", () => {
    // Edits change the working copy, not currentCode; the input is unchanged.
    const { fired } = simulate([restored, { ...restored, isRendering: true }, restored, restored]);
    expect(fired).toBe(1);
  });

  it("stops once the STL lands", () => {
    const { fired } = simulate([restored, { ...restored, isRendering: true }, { ...restored, needsRerender: false, hasStl: true }]);
    expect(fired).toBe(1);
  });

  it("never fires when the viewer already has an STL", () => {
    expect(stepAutoRerender({ ...restored, hasStl: true }, null).fire).toBe(false);
  });

  it("does not fire without code, while rendering, or for a live thread", () => {
    expect(stepAutoRerender({ ...restored, currentCode: "  " }, null).fire).toBe(false);
    expect(stepAutoRerender({ ...restored, isRendering: true }, null).fire).toBe(false);
    expect(stepAutoRerender({ ...restored, needsRerender: false }, null).fire).toBe(false);
  });

  it("fires again only for a different current code", () => {
    const { fired, attempted } = simulate([restored, restored, { ...restored, currentCode: "cyl()" }, { ...restored, currentCode: "cyl()" }]);
    expect(fired).toBe(2);
    expect(attempted).toBe("cyl()");
  });

  it("keeps the previous attempt when not firing", () => {
    expect(stepAutoRerender({ ...restored, hasStl: true }, "box()")).toEqual({ fire: false, attemptedCode: "box()" });
  });
});

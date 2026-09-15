// A thread restored from localStorage has code but no STL (persistence strips
// it). The design session re-renders that code once, automatically, so the
// viewer is not left empty. Rules:
// - never when the viewer already shows an STL, or without code;
// - at most once per current code per page load (a failed attempt waits for a
//   manual Re-render instead of looping, and each attempt costs render quota);
// - edits to the working copy don't count: only a new current design can
//   trigger another attempt.
// The design session threads `attemptedCode` through React state and calls
// this from an effect. Pure; unit-tested in auto-rerender.test.ts.
export interface AutoRerenderInput {
  needsRerender: boolean;
  hasStl: boolean;
  isRendering: boolean;
  currentCode: string;
}

export function stepAutoRerender(
  input: AutoRerenderInput,
  attemptedCode: string | null,
): { fire: boolean; attemptedCode: string | null } {
  const fire =
    input.needsRerender &&
    !input.hasStl &&
    !input.isRendering &&
    input.currentCode.trim() !== "" &&
    attemptedCode !== input.currentCode;
  return { fire, attemptedCode: fire ? input.currentCode : attemptedCode };
}

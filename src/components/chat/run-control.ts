// The composer's run button is Send while idle and Stop while a turn runs.
// A double-click on Send would land its second click on Stop and cancel the
// run it just started, so Stop ignores activations shortly after the run
// begins. Pure; unit-tested in run-control.test.ts.
export const STOP_GUARD_MS = 300;

export function isStopGuarded(now: number, runStartedAt: number | null, guardMs: number = STOP_GUARD_MS): boolean {
  return runStartedAt !== null && now - runStartedAt < guardMs;
}

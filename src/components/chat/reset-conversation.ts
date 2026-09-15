// New Chat sequencing. Pure and injectable; unit-tested in
// reset-conversation.test.ts.
//
// @assistant-ui/core's external-store cancelRun() snapshots the current
// messages and writes them back on a setTimeout(0). A reset() issued right
// after it is overwritten by that deferred write, restoring the old thread.
// So: cancel only when a turn is actually running, and then reset on a later
// macrotask. Timers with the same delay fire in scheduling order, so a
// setTimeout(0) queued after cancelRun() runs after its restore. The AI SDK
// Chat drops every stream write once its request is aborted, so nothing else
// can repopulate the thread after that point.

export interface ResettableThread {
  cancelRun(): void;
  reset(): void;
}

export interface ResetConversationOptions {
  isRunning: boolean;
  // UI state tied to the conversation (design session, composer, tabs, model).
  resetLocalState: () => void;
  // Runs last, once the thread is empty, so no stale save can follow it.
  clearPersisted: () => void;
  // Resolves on a macrotask queued after cancelRun()'s deferred restore.
  nextMacrotask?: () => Promise<void>;
}

const defaultNextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function resetConversation(thread: ResettableThread, options: ResetConversationOptions): Promise<void> {
  const { isRunning, resetLocalState, clearPersisted, nextMacrotask = defaultNextMacrotask } = options;
  if (isRunning) {
    thread.cancelRun();
    await nextMacrotask();
  }
  thread.reset();
  resetLocalState();
  clearPersisted();
}

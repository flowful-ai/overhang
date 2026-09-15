import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetConversation } from "@/components/chat/reset-conversation";

// Mirrors @assistant-ui/core's ExternalStoreThreadRuntimeCore: cancelRun()
// snapshots the current messages and writes them back on a setTimeout(0),
// while reset() empties the thread synchronously.
function fakeThread(initial: string[]) {
  const thread = {
    messages: [...initial],
    cancelRun: vi.fn(() => {
      const snapshot = [...thread.messages];
      setTimeout(() => {
        thread.messages = snapshot;
      }, 0);
    }),
    reset: vi.fn(() => {
      thread.messages = [];
    }),
  };
  return thread;
}

async function run(thread: ReturnType<typeof fakeThread>, isRunning: boolean) {
  const log: string[] = [];
  const resetLocalState = vi.fn(() => log.push(`local:${thread.messages.length}`));
  const clearPersisted = vi.fn(() => log.push(`clear:${thread.messages.length}`));
  const done = resetConversation(thread, { isRunning, resetLocalState, clearPersisted });
  await vi.runAllTimersAsync();
  await done;
  // Anything cancelRun deferred has fired by now.
  await vi.runAllTimersAsync();
  return { log, resetLocalState, clearPersisted };
}

describe("resetConversation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves an empty thread when a turn is running", async () => {
    const thread = fakeThread(["user", "assistant"]);
    const { log } = await run(thread, true);

    expect(thread.cancelRun).toHaveBeenCalledTimes(1);
    expect(thread.messages).toEqual([]);
    // Local state and storage are cleared only once the thread is empty.
    expect(log).toEqual(["local:0", "clear:0"]);
  });

  it("leaves an empty thread when idle, without cancelling", async () => {
    const thread = fakeThread(["user", "assistant"]);
    const { log } = await run(thread, false);

    expect(thread.messages).toEqual([]);
    expect(thread.cancelRun).not.toHaveBeenCalled();
    expect(log).toEqual(["local:0", "clear:0"]);
  });

  it("clears storage last, after the thread reset", async () => {
    const thread = fakeThread(["user"]);
    const { clearPersisted, resetLocalState } = await run(thread, true);

    expect(thread.reset.mock.invocationCallOrder[0]).toBeLessThan(resetLocalState.mock.invocationCallOrder[0]);
    expect(resetLocalState.mock.invocationCallOrder[0]).toBeLessThan(clearPersisted.mock.invocationCallOrder[0]);
  });
});

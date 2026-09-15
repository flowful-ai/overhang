import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageQueueController, type MessageQueueController } from "@/components/chat/message-queue";
import { createQueueDriver, type QueueDriver } from "@/components/chat/queue-driver";
import { resetConversation } from "@/components/chat/reset-conversation";

// The queue driven through a fake thread that behaves like the AI SDK runtime
// under @assistant-ui/core: append starts a run with an optimistic empty
// assistant placeholder, a turn ends on an assistant message whose status
// says how it went, and cancelRun() ends the run and deletes the user message
// when no reply has streamed yet (its deferred restore is not modelled).

type Status = { type: string; reason?: string; error?: unknown };
interface Msg {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: Status;
  content: readonly unknown[];
  metadata?: { isOptimistic?: boolean };
}

const BUSY = JSON.stringify({ error: "Overhang is busy right now. Please try again in a moment." });

function fakeThread() {
  let seq = 0;
  const t = {
    isRunning: false,
    messages: [] as Msg[],
    appended: [] as { text: string; image: string | null }[],
    startRuns: [] as string[],
    append: vi.fn((text: string, image: string | null) => {
      t.appended.push({ text, image });
      t.messages = [...t.messages, { id: `u${++seq}`, role: "user", text, content: [{ type: "text", text }] }];
      t.begin();
    }),
    startRun: vi.fn((parentId: string) => {
      t.startRuns.push(parentId);
      const at = t.messages.findIndex((m) => m.id === parentId);
      t.messages = t.messages.slice(0, at + 1);
      t.begin();
    }),
    cancelRun: vi.fn(() => {
      t.isRunning = false;
      let msgs = t.messages;
      const head = msgs.at(-1);
      if (head?.metadata?.isOptimistic && head.content.length === 0) msgs = msgs.slice(0, -1);
      if (msgs.at(-1)?.role === "user") msgs = msgs.slice(0, -1);
      // A partial reply stays, and the runtime reports it as complete.
      t.messages = msgs.map((m) => (m.status?.type === "running" ? { ...m, status: { type: "complete" } } : m));
    }),
    reset: vi.fn(() => {
      t.messages = [];
    }),
    begin() {
      t.isRunning = true;
      t.messages = [
        ...t.messages,
        { id: `a${++seq}`, role: "assistant", text: "", content: [], status: { type: "running" }, metadata: { isOptimistic: true } },
      ];
    },
    // The first reply chunk: the placeholder becomes a real message.
    stream() {
      t.messages = t.messages.map((m, i) =>
        i === t.messages.length - 1 ? { ...m, content: [{ type: "text", text: "..." }], metadata: {} } : m,
      );
    },
    finish(status: Status) {
      t.isRunning = false;
      t.messages = t.messages.map((m, i) =>
        i === t.messages.length - 1 ? { ...m, content: [{ type: "text", text: "done" }], metadata: {}, status } : m,
      );
    },
  };
  return t;
}

let queue: MessageQueueController;
let driver: QueueDriver;
let thread: ReturnType<typeof fakeThread>;

// What ChatInterface's effect does on every render.
const observe = () => driver.observe(thread, { isRunning: thread.isRunning, messages: thread.messages });
const enqueue = (text: string, image: string | null = null) =>
  queue.dispatch({ type: "enqueue", text, image, maxLength: 10_000 });

// The user sends a message directly and a turn starts.
function startTurn(text = "make a cube") {
  thread.append(text, null);
  observe();
}

beforeEach(() => {
  queue = createMessageQueueController();
  driver = createQueueDriver(queue, false);
  thread = fakeThread();
});

describe("queue driver", () => {
  it("appends exactly once per finished turn, in queue order, through the normal send", () => {
    startTurn();
    enqueue("taller", "data:img");
    enqueue("  ");
    enqueue("add fillets");
    thread.append.mockClear();

    thread.finish({ type: "complete" });
    observe();
    observe(); // an effect re-run with the same state
    expect(thread.append).toHaveBeenCalledTimes(1);
    expect(thread.append).toHaveBeenLastCalledWith("taller", "data:img");

    observe(); // the run the send started
    thread.finish({ type: "complete" });
    observe();
    observe();
    expect(thread.append).toHaveBeenCalledTimes(2);
    expect(thread.append).toHaveBeenLastCalledWith("add fillets", null);

    observe();
    thread.finish({ type: "complete" });
    observe();
    expect(thread.append).toHaveBeenCalledTimes(2);
  });

  it("does not append when the turn failed, and Send next sends the head", () => {
    startTurn();
    enqueue("taller");
    thread.finish({ type: "incomplete", reason: "error", error: "The operation was aborted due to timeout" });
    observe();
    expect(thread.appended).toHaveLength(1);
    expect(queue.getState().pausedBy).toBe("error");

    driver.resume(thread, { isRunning: thread.isRunning, messages: thread.messages });
    expect(thread.appended.at(-1)?.text).toBe("taller");
    expect(queue.getState().items).toHaveLength(0);
  });

  it("pauses neutrally when the turn ended on a tool call with no result", () => {
    startTurn();
    enqueue("taller");
    thread.finish({ type: "requires-action", reason: "tool-calls" });
    observe();
    expect(thread.appended).toHaveLength(1);
    expect(queue.getState().pausedBy).toBe("interrupted");
  });

  it("records Stop before cancelRun, so the turn's end pauses instead of sending", () => {
    startTurn();
    thread.stream();
    enqueue("taller");
    thread.cancelRun.mockImplementation(() => {
      expect(queue.getState().stopRequested).toBe(true);
      thread.isRunning = false;
      thread.messages = thread.messages.map((m) => ({ ...m, status: { type: "complete" } }));
    });

    driver.stop(thread, thread.messages);
    observe();
    expect(thread.cancelRun).toHaveBeenCalledOnce();
    expect(thread.appended).toHaveLength(1);
    expect(queue.getState().pausedBy).toBe("stopped");
    expect(queue.getState().items.map((i) => i.text)).toEqual(["taller"]);
  });

  it("puts a queued message stopped before any reply back at the head of the queue", () => {
    startTurn();
    enqueue("taller", "data:img");
    enqueue("add fillets");
    thread.finish({ type: "complete" });
    observe(); // auto-sends "taller"
    observe();

    driver.stop(thread, thread.messages);
    observe();
    // The runtime deleted the user message from the thread...
    expect(thread.messages.some((m) => m.text === "taller")).toBe(false);
    // ...and the queue still has it, first, with its snapshot.
    expect(queue.getState().items.map(({ text, image }) => ({ text, image }))).toEqual([
      { text: "taller", image: "data:img" },
      { text: "add fillets", image: null },
    ]);
    expect(queue.getState().pausedBy).toBe("stopped");

    driver.resume(thread, { isRunning: thread.isRunning, messages: thread.messages });
    expect(thread.appended.at(-1)).toEqual({ text: "taller", image: "data:img" });
  });

  it("keeps a stopped message that already has a reply in the thread, not in the queue", () => {
    startTurn();
    enqueue("taller");
    enqueue("add fillets");
    thread.finish({ type: "complete" });
    observe();
    observe();
    thread.stream();

    driver.stop(thread, thread.messages);
    observe();
    expect(thread.messages.some((m) => m.text === "taller")).toBe(true);
    expect(queue.getState().items.map((i) => i.text)).toEqual(["add fillets"]);
  });

  it("New Chat clears the queue before cancelling, so the cancelled turn sends nothing", async () => {
    vi.useFakeTimers();
    try {
      startTurn();
      enqueue("taller");
      const cancel = thread.cancelRun.getMockImplementation()!;
      thread.cancelRun.mockImplementation(() => {
        expect(queue.getState().items).toHaveLength(0);
        cancel();
        observe(); // the render after cancelling, before the reset
      });

      const done = resetConversation(thread, {
        isRunning: thread.isRunning,
        clearQueue: driver.clear,
        resetLocalState: () => {},
        clearPersisted: () => {},
      });
      await vi.runAllTimersAsync();
      await done;
      observe();

      expect(thread.cancelRun).toHaveBeenCalledOnce();
      expect(thread.appended).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resume while running sends once, when that turn ends", () => {
    startTurn();
    enqueue("taller");
    thread.finish({ type: "incomplete", reason: "error", error: "boom" });
    observe();
    startTurn("something else"); // sent directly while paused

    driver.resume(thread, { isRunning: thread.isRunning, messages: thread.messages });
    expect(thread.appended).toHaveLength(2);

    thread.finish({ type: "complete" });
    observe();
    observe();
    expect(thread.appended.map((a) => a.text)).toEqual(["make a cube", "something else", "taller"]);
  });

  it("pauses on the busy 503 and Send next retries the failed message before the rest", () => {
    startTurn();
    enqueue("taller");
    enqueue("add fillets");
    thread.finish({ type: "complete" });
    observe(); // auto-sends "taller"
    observe();
    thread.finish({ type: "incomplete", reason: "error", error: BUSY });
    observe();
    expect(queue.getState().pausedBy).toBe("busy");
    expect(thread.appended).toHaveLength(2);

    driver.resume(thread, { isRunning: thread.isRunning, messages: thread.messages });
    const failedUser = thread.messages.filter((m) => m.role === "user").at(-1)!;
    expect(thread.startRun).toHaveBeenCalledWith(failedUser.id);
    expect(failedUser.text).toBe("taller");
    expect(thread.appended).toHaveLength(2); // retried, not sent twice

    observe();
    thread.finish({ type: "complete" });
    observe();
    expect(thread.appended.at(-1)?.text).toBe("add fillets");
  });
});

describe("queue driver initial state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not treat the first observation as an edge", () => {
    const q = createMessageQueueController();
    const d = createQueueDriver(q, true);
    const t = fakeThread();
    q.dispatch({ type: "enqueue", text: "a", image: null, maxLength: 10 });
    d.observe(t, { isRunning: true, messages: [] });
    expect(t.append).not.toHaveBeenCalled();
  });
});

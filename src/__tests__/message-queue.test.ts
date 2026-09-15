import { describe, it, expect, vi } from "vitest";
import {
  MAX_QUEUED_MESSAGES,
  classifyTurnEnd,
  createMessageQueueController,
  initialQueueState,
  outgoingText,
  queueReducer,
  stopDropsLastUserMessage,
  validateOutgoing,
  type MessageQueueController,
} from "@/components/chat/message-queue";

const MAX = 10_000;

function enqueue(q: MessageQueueController, text: string, image: string | null = null) {
  return q.dispatch({ type: "enqueue", text, image, maxLength: MAX });
}

// A queue holding these prompts, queued during a running turn.
function runningWith(...texts: string[]) {
  const q = createMessageQueueController();
  q.dispatch({ type: "runStarted" });
  for (const t of texts) enqueue(q, t);
  return q;
}

const texts = (q: MessageQueueController) => q.getState().items.map((i) => i.text);
const busyError = new Error(JSON.stringify({ error: "Overhang is busy right now. Please try again in a moment." }));

describe("validateOutgoing / outgoingText", () => {
  it("rejects empty and over-long prompts, accepts a bare snapshot", () => {
    expect(validateOutgoing("   ", null, MAX)).toBe("empty");
    expect(validateOutgoing("a".repeat(MAX + 1), null, MAX)).toBe("too-long");
    expect(validateOutgoing("a".repeat(MAX), null, MAX)).toBeNull();
    expect(validateOutgoing("", "data:image/png;base64,x", MAX)).toBeNull();
  });

  it("defaults a bare snapshot's prompt", () => {
    expect(outgoingText("  ", "data:x")).toBe("Analyze this snapshot");
    expect(outgoingText(" hi ", "data:x")).toBe("hi");
  });
});

describe("classifyTurnEnd", () => {
  const assistant = (status: { type: string; reason?: string; error?: unknown }) => [
    { role: "user" },
    { role: "assistant", status },
  ];

  it("reads the last assistant message", () => {
    expect(classifyTurnEnd(assistant({ type: "complete", reason: "unknown" }))).toBe("done");
    expect(classifyTurnEnd(assistant({ type: "incomplete", reason: "error", error: "boom" }))).toBe("error");
    expect(classifyTurnEnd(assistant({ type: "incomplete", reason: "error", error: busyError.message }))).toBe("busy");
    expect(classifyTurnEnd(assistant({ type: "requires-action", reason: "tool-calls" }))).toBe("interrupted");
    expect(classifyTurnEnd(assistant({ type: "incomplete", reason: "length" }))).toBe("interrupted");
  });

  it("treats a thread without a reply as failed", () => {
    expect(classifyTurnEnd([{ role: "user" }])).toBe("error");
    expect(classifyTurnEnd([])).toBe("error");
  });

  it("maps the server's turn timeout error to error", () => {
    const status = { type: "incomplete", reason: "error", error: "The operation was aborted due to timeout" };
    expect(classifyTurnEnd(assistant(status))).toBe("error");
  });
});

describe("stopDropsLastUserMessage", () => {
  it("is true when no reply has streamed yet", () => {
    expect(stopDropsLastUserMessage([{ role: "user" }])).toBe(true);
    expect(
      stopDropsLastUserMessage([{ role: "user" }, { role: "assistant", content: [], metadata: { isOptimistic: true } }]),
    ).toBe(true);
  });

  it("is false once the reply exists", () => {
    expect(stopDropsLastUserMessage([{ role: "user" }, { role: "assistant", content: [{}] }])).toBe(false);
    expect(stopDropsLastUserMessage([{ role: "user" }, { role: "assistant", content: [] }])).toBe(false);
    expect(stopDropsLastUserMessage([])).toBe(false);
  });
});

describe("enqueue", () => {
  it("keeps the raw prompt and snapshot in order", () => {
    const q = runningWith("first");
    const r = enqueue(q, "  second ", "data:img");
    expect(r.rejected).toBeNull();
    expect(r.announce).toBe("Message queued. 2 in queue.");
    expect(q.getState().items.map(({ text, image }) => ({ text, image }))).toEqual([
      { text: "first", image: null },
      { text: "  second ", image: "data:img" },
    ]);
  });

  it("validates like a normal send", () => {
    const q = runningWith();
    expect(enqueue(q, "").rejected).toBe("empty");
    expect(enqueue(q, "a".repeat(MAX + 1)).rejected).toBe("too-long");
    expect(q.getState().items).toHaveLength(0);
  });

  it("caps the queue", () => {
    const q = runningWith(...Array.from({ length: MAX_QUEUED_MESSAGES }, (_, i) => `m${i}`));
    const r = enqueue(q, "one too many");
    expect(r.rejected).toBe("full");
    expect(q.getState().items).toHaveLength(MAX_QUEUED_MESSAGES);
  });
});

describe("edit and remove", () => {
  it("take removes the item and returns it for the composer", () => {
    const q = runningWith("a", "b", "c");
    const id = q.getState().items[1].id;
    const r = q.dispatch({ type: "take", id });
    expect(r.taken?.text).toBe("b");
    expect(texts(q)).toEqual(["a", "c"]);
  });

  it("remove drops the item; unknown ids are a no-op", () => {
    const q = runningWith("a", "b");
    q.dispatch({ type: "remove", id: q.getState().items[0].id });
    expect(texts(q)).toEqual(["b"]);
    const before = q.getState();
    expect(q.dispatch({ type: "remove", id: 999 }).state).toBe(before);
  });

  it("emptying a paused queue clears the pause", () => {
    const q = runningWith("a");
    q.dispatch({ type: "runEnded", outcome: "error" });
    expect(q.getState().pausedBy).toBe("error");
    q.dispatch({ type: "remove", id: q.getState().items[0].id });
    expect(q.getState().pausedBy).toBeNull();
  });
});

describe("auto-send", () => {
  it("sends the head when a turn finishes normally, then the next after the next turn", () => {
    const q = runningWith("a", "b", "c");
    const sent: string[] = [];

    for (let turn = 0; turn < 3; turn++) {
      const r = q.dispatch({ type: "runEnded", outcome: "done" });
      expect(r.send).not.toBeNull();
      expect(q.getState().inFlight).toBe(r.send);
      sent.push(r.send!.text);
      // Sending the item starts the next turn.
      q.dispatch({ type: "runStarted" });
    }

    expect(sent).toEqual(["a", "b", "c"]);
    expect(q.dispatch({ type: "runEnded", outcome: "done" }).send).toBeNull();
    expect(q.getState().inFlight).toBeNull();
  });

  it("sends nothing when the queue is empty", () => {
    const q = runningWith();
    expect(q.dispatch({ type: "runEnded", outcome: "done" }).send).toBeNull();
    expect(q.getState().pausedBy).toBeNull();
  });
});

describe("pause and resume", () => {
  it.each(["error", "busy", "interrupted"] as const)("pauses instead of sending when the turn ended %s", (outcome) => {
    const q = runningWith("a");
    const r = q.dispatch({ type: "runEnded", outcome });
    expect(r.send).toBeNull();
    expect(r.announce).toBe("Queue paused.");
    expect(q.getState().pausedBy).toBe(outcome);
  });

  it("pauses when the user pressed Stop, even if the reply looks complete", () => {
    const q = runningWith("a");
    q.dispatch({ type: "stop", sentMessageDropped: false });
    const r = q.dispatch({ type: "runEnded", outcome: "done" });
    expect(r.send).toBeNull();
    expect(q.getState().pausedBy).toBe("stopped");
    expect(q.getState().stopRequested).toBe(false);
  });

  it("a Stop in one turn does not pause the next", () => {
    const q = runningWith();
    q.dispatch({ type: "stop", sentMessageDropped: false });
    q.dispatch({ type: "runEnded", outcome: "done" });
    q.dispatch({ type: "runStarted" });
    enqueue(q, "a");
    expect(q.dispatch({ type: "runEnded", outcome: "done" }).send?.text).toBe("a");
  });

  it("stays paused across a turn started some other way (e.g. Retry), keeping the latest reason", () => {
    const q = runningWith("a", "b");
    q.dispatch({ type: "runEnded", outcome: "busy" });
    q.dispatch({ type: "runStarted" });
    const done = q.dispatch({ type: "runEnded", outcome: "done" });
    expect(done.send).toBeNull();
    expect(done.announce).toBeNull();
    expect(q.getState().pausedBy).toBe("busy");
    q.dispatch({ type: "runStarted" });
    q.dispatch({ type: "runEnded", outcome: "error" });
    expect(q.getState().pausedBy).toBe("error");
  });

  it("resume while idle sends the head now, and later items follow automatically", () => {
    const q = runningWith("a", "b");
    q.dispatch({ type: "runEnded", outcome: "error" });
    const r = q.dispatch({ type: "resume", isRunning: false, canRetry: true });
    expect(r.send?.text).toBe("a");
    expect(r.retry).toBe(false);
    expect(q.getState().pausedBy).toBeNull();
    q.dispatch({ type: "runStarted" });
    expect(q.dispatch({ type: "runEnded", outcome: "done" }).send?.text).toBe("b");
  });

  it("resume mid-turn only unpauses; the turn's end sends", () => {
    const q = runningWith("a");
    q.dispatch({ type: "stop", sentMessageDropped: false });
    q.dispatch({ type: "runEnded", outcome: "done" });
    q.dispatch({ type: "runStarted" });
    const r = q.dispatch({ type: "resume", isRunning: true, canRetry: false });
    expect(r.send).toBeNull();
    expect(q.getState().pausedBy).toBeNull();
    expect(q.dispatch({ type: "runEnded", outcome: "done" }).send?.text).toBe("a");
  });

  it("resume after busy retries the failed message and keeps the queue intact", () => {
    const q = runningWith("a");
    q.dispatch({ type: "runEnded", outcome: "busy" });
    const r = q.dispatch({ type: "resume", isRunning: false, canRetry: true });
    expect(r.retry).toBe(true);
    expect(r.send).toBeNull();
    expect(texts(q)).toEqual(["a"]);
    expect(q.getState().pausedBy).toBeNull();
  });

  it("resume after busy sends the head when there is nothing left to retry", () => {
    const q = runningWith("a");
    q.dispatch({ type: "runEnded", outcome: "busy" });
    const r = q.dispatch({ type: "resume", isRunning: false, canRetry: false });
    expect(r.retry).toBe(false);
    expect(r.send?.text).toBe("a");
  });
});

describe("stop before the reply streams", () => {
  it("returns the queue's in-flight message to the head of the queue, paused", () => {
    const q = runningWith("a", "b");
    const { send } = q.dispatch({ type: "runEnded", outcome: "done" });
    q.dispatch({ type: "runStarted" });
    const r = q.dispatch({ type: "stop", sentMessageDropped: true });
    expect(r.announce).toBe("Stopped message returned to the queue.");
    expect(q.getState().items[0]).toBe(send);
    expect(texts(q)).toEqual(["a", "b"]);
    q.dispatch({ type: "runEnded", outcome: "done" });
    expect(q.getState().pausedBy).toBe("stopped");
  });

  it("restores past the cap rather than losing the message", () => {
    const q = runningWith(...Array.from({ length: MAX_QUEUED_MESSAGES }, (_, i) => `m${i}`));
    q.dispatch({ type: "runEnded", outcome: "done" });
    q.dispatch({ type: "runStarted" });
    enqueue(q, "fills the cap again");
    q.dispatch({ type: "stop", sentMessageDropped: true });
    expect(q.getState().items).toHaveLength(MAX_QUEUED_MESSAGES + 1);
  });

  it("restores nothing for a turn the queue did not send", () => {
    const q = runningWith("a");
    q.dispatch({ type: "stop", sentMessageDropped: true });
    expect(texts(q)).toEqual(["a"]);
  });
});

describe("clear (New Chat)", () => {
  it("drops items, pause, stop flag and in-flight item", () => {
    const q = runningWith("a", "b");
    q.dispatch({ type: "runEnded", outcome: "done" });
    q.dispatch({ type: "stop", sentMessageDropped: false });
    q.dispatch({ type: "clear" });
    expect(q.getState()).toMatchObject({ items: [], pausedBy: null, stopRequested: false, inFlight: null });
    // The cancelled turn ending afterwards sends nothing.
    expect(q.dispatch({ type: "runEnded", outcome: "done" }).send).toBeNull();
  });

  it("never reuses ids, so a stale Edit/Remove cannot hit a new item", () => {
    const q = runningWith("a");
    const oldId = q.getState().items[0].id;
    q.dispatch({ type: "clear" });
    enqueue(q, "b");
    expect(q.getState().items[0].id).not.toBe(oldId);
  });
});

describe("controller", () => {
  it("notifies subscribers only when state changes", () => {
    const q = createMessageQueueController();
    const listener = vi.fn();
    const unsubscribe = q.subscribe(listener);
    enqueue(q, "a");
    expect(listener).toHaveBeenCalledTimes(1);
    q.dispatch({ type: "remove", id: 999 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    enqueue(q, "b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("bumps the announcement sequence even for a repeated text", () => {
    const q = runningWith();
    enqueue(q, "a");
    q.dispatch({ type: "remove", id: q.getState().items[0].id });
    const first = q.getState().announcementSeq;
    enqueue(q, "b");
    q.dispatch({ type: "remove", id: q.getState().items[0].id });
    expect(q.getState().announcement).toBe("Queued message removed.");
    expect(q.getState().announcementSeq).toBe(first + 2);
  });

  it("the reducer is pure", () => {
    const before = { ...initialQueueState };
    queueReducer(initialQueueState, { type: "enqueue", text: "a", image: null, maxLength: MAX });
    expect(initialQueueState).toEqual(before);
  });
});

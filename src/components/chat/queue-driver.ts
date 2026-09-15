import { findRetryTarget } from "./chat-error";
import {
  classifyTurnEnd,
  outgoingText,
  stopDropsLastUserMessage,
  type MessageQueueController,
} from "./message-queue";

// Connects the message queue to the chat thread: watches the running/idle
// edges, sends the next item, pauses, stops, resumes. Kept free of React so
// the wiring is tested against a fake thread (queue-driver.test.ts);
// ChatInterface calls observe() from an effect and forwards user actions.

// The slice of the thread runtime the queue needs.
export interface QueueThread {
  // The same append a typed message uses, so the transport projects the basis
  // and applies model and web-search settings at send time.
  append: (text: string, image: string | null) => void;
  cancelRun: () => void;
  // Regenerate from a user message (the Retry path).
  startRun: (parentId: string) => void;
}

interface DriverMessage {
  id: string;
  role: string;
  status?: { type: string; reason?: string; error?: unknown };
  content?: readonly unknown[];
  metadata?: { isOptimistic?: boolean };
}

export interface ThreadSnapshot {
  isRunning: boolean;
  messages: readonly DriverMessage[];
}

export interface QueueDriver {
  // Call with every new thread snapshot. Acts only on a running/idle edge, so
  // repeated calls with the same state do nothing.
  observe: (thread: QueueThread, snapshot: ThreadSnapshot) => void;
  // User pressed Stop. Recorded before cancelling, so the turn's end pauses.
  stop: (thread: QueueThread, messages: readonly DriverMessage[]) => void;
  // "Send next" / "Resume".
  resume: (thread: QueueThread, snapshot: ThreadSnapshot) => void;
  // New Chat. Must run before the running turn is cancelled.
  clear: () => void;
}

export function createQueueDriver(queue: MessageQueueController, initiallyRunning: boolean): QueueDriver {
  let wasRunning = initiallyRunning;

  return {
    observe(thread, { isRunning, messages }) {
      if (wasRunning === isRunning) return;
      wasRunning = isRunning;
      if (isRunning) {
        queue.dispatch({ type: "runStarted" });
        return;
      }
      const { send } = queue.dispatch({ type: "runEnded", outcome: classifyTurnEnd(messages) });
      if (send) thread.append(outgoingText(send.text, send.image), send.image);
    },

    stop(thread, messages) {
      queue.dispatch({ type: "stop", sentMessageDropped: stopDropsLastUserMessage(messages) });
      thread.cancelRun();
    },

    resume(thread, { isRunning, messages }) {
      const retryTarget = findRetryTarget(messages, isRunning);
      const { send, retry } = queue.dispatch({ type: "resume", isRunning, canRetry: retryTarget !== null });
      if (retry && retryTarget) thread.startRun(retryTarget);
      else if (send) thread.append(outgoingText(send.text, send.image), send.image);
    },

    clear() {
      queue.dispatch({ type: "clear" });
    },
  };
}

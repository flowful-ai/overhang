import { extractErrorText, isBusyError } from "./chat-error";

// Messages typed while an agent turn is running wait here and go out one per
// turn once the current one finishes. Owned by the chat layer rather than
// @assistant-ui's runtime queue: useChatRuntime does not wire a queue adapter,
// and the core queue clears itself on cancel, advances after failed turns and
// freezes the outgoing message at enqueue time. This queue instead keeps the
// raw prompt and snapshot, so the normal send path (basis projection, image
// stripping, model and web-search settings) applies when the item is sent.
//
// In memory only: a reload or New Chat drops it. Pure; unit-tested in
// message-queue.test.ts. queue-driver.ts connects it to the thread.

export const MAX_QUEUED_MESSAGES = 5;

export interface QueuedMessage {
  id: number;
  // The prompt exactly as typed, so Edit restores it verbatim.
  text: string;
  image: string | null;
}

// How a turn ended, read from the thread once it stops running.
// - done: a complete assistant reply.
// - busy: the server had no free generation slot (503); the turn can be retried.
// - error: any other failure, including the server's turn timeout.
// - interrupted: the reply ended without failing but did not finish (a tool
//   call with no result, a length cut-off).
export type TurnOutcome = "done" | "busy" | "error" | "interrupted";

// Why auto-send stopped. Only meaningful while items are waiting.
export type PauseReason = Exclude<TurnOutcome, "done"> | "stopped";

export interface MessageQueueState {
  items: readonly QueuedMessage[];
  pausedBy: PauseReason | null;
  // Stop was pressed during the current turn: its end must not auto-send.
  stopRequested: boolean;
  // The item the queue sent for the current turn, until that turn ends.
  inFlight: QueuedMessage | null;
  nextId: number;
  // Latest polite screen-reader announcement; the sequence number changes on
  // every announcement so a repeated text is still re-rendered.
  announcement: string | null;
  announcementSeq: number;
}

export type RejectReason = "empty" | "too-long" | "full";

export type QueueAction =
  | { type: "enqueue"; text: string; image: string | null; maxLength: number }
  | { type: "remove"; id: number }
  // Edit: remove the item and hand it back to the composer.
  | { type: "take"; id: number }
  // sentMessageDropped: cancelling will delete the turn's user message from
  // the thread (see stopDropsLastUserMessage).
  | { type: "stop"; sentMessageDropped: boolean }
  | { type: "runStarted" }
  | { type: "runEnded"; outcome: TurnOutcome }
  // canRetry: the thread ends on a failed turn that can be regenerated.
  | { type: "resume"; isRunning: boolean; canRetry: boolean }
  | { type: "clear" };

export interface QueueResult {
  state: MessageQueueState;
  // The item to send now through the normal send path.
  send: QueuedMessage | null;
  // Regenerate the failed turn instead of sending an item.
  retry: boolean;
  // The item removed by "take".
  taken: QueuedMessage | null;
  rejected: RejectReason | null;
  // Announcement made by this transition, also stored on the state.
  announce: string | null;
}

export const initialQueueState: MessageQueueState = {
  items: [],
  pausedBy: null,
  stopRequested: false,
  inFlight: null,
  nextId: 1,
  announcement: null,
  announcementSeq: 0,
};

// Shared by a direct send and an enqueue, so both reject the same input.
export function validateOutgoing(text: string, image: string | null, maxLength: number): "empty" | "too-long" | null {
  if (!text.trim() && !image) return "empty";
  if (text.length > maxLength) return "too-long";
  return null;
}

// The user-message text actually sent: a bare snapshot gets a default prompt.
export function outgoingText(text: string, image: string | null): string {
  return text.trim() || (image ? "Analyze this snapshot" : "");
}

interface SettledMessage {
  role: string;
  status?: { type: string; reason?: string; error?: unknown };
}

// The thread's message status is not enough on its own: with the AI SDK
// runtime an aborted stream ends as a "complete" message. A user Stop is
// therefore recorded explicitly (the "stop" action), and the server reports
// its own turn timeout as an error chunk, which lands here as an incomplete
// message with reason "error".
export function classifyTurnEnd(messages: readonly SettledMessage[]): TurnOutcome {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return "error";
  const status = last.status;
  if (status?.type === "complete") return "done";
  if (status?.type === "incomplete" && status.reason === "error") {
    return isBusyError(extractErrorText(status.error)) ? "busy" : "error";
  }
  return "interrupted";
}

interface CancellableMessage {
  role: string;
  content?: readonly unknown[];
  metadata?: { isOptimistic?: boolean };
}

// Mirrors @assistant-ui/core's cancelRun(): it drops an empty optimistic
// assistant placeholder, and if the thread then ends on the user message (no
// reply streamed yet) it deletes that message and moves its text into the
// runtime's own composer, which this app does not render.
export function stopDropsLastUserMessage(messages: readonly CancellableMessage[]): boolean {
  let end = messages.length;
  const head = messages[end - 1];
  if (head?.metadata?.isOptimistic && (head.content?.length ?? 0) === 0) end--;
  return messages[end - 1]?.role === "user";
}

function result(state: MessageQueueState, extra: Partial<Omit<QueueResult, "state">> = {}): QueueResult {
  const announced = extra.announce
    ? { ...state, announcement: extra.announce, announcementSeq: state.announcementSeq + 1 }
    : state;
  return { state: announced, send: null, retry: false, taken: null, rejected: null, announce: null, ...extra };
}

// Removes the head for sending. Pausing ends once nothing is left to hold back.
function dequeue(state: MessageQueueState): QueueResult {
  const [head, ...rest] = state.items;
  if (!head) return result({ ...state, pausedBy: null });
  return result({ ...state, items: rest, pausedBy: null, inFlight: head }, { send: head });
}

function without(state: MessageQueueState, id: number): { state: MessageQueueState; item: QueuedMessage | null } {
  const item = state.items.find((i) => i.id === id) ?? null;
  if (!item) return { state, item: null };
  const items = state.items.filter((i) => i.id !== id);
  return { state: { ...state, items, pausedBy: items.length > 0 ? state.pausedBy : null }, item };
}

export function queueReducer(state: MessageQueueState, action: QueueAction): QueueResult {
  switch (action.type) {
    case "enqueue": {
      const invalid = validateOutgoing(action.text, action.image, action.maxLength);
      if (invalid) return result(state, { rejected: invalid });
      if (state.items.length >= MAX_QUEUED_MESSAGES) return result(state, { rejected: "full" });
      const item: QueuedMessage = { id: state.nextId, text: action.text, image: action.image };
      const items = [...state.items, item];
      return result(
        { ...state, items, nextId: state.nextId + 1 },
        { announce: `Message queued. ${items.length} in queue.` },
      );
    }
    case "remove": {
      const next = without(state, action.id);
      return result(next.state, { announce: next.item ? "Queued message removed." : null });
    }
    case "take": {
      const next = without(state, action.id);
      return result(next.state, { taken: next.item });
    }
    case "stop": {
      const stopped = { ...state, stopRequested: true };
      // The queue's own message is about to vanish from the thread: put it
      // back at the head (allowed past the cap) so nothing is lost.
      if (action.sentMessageDropped && state.inFlight) {
        return result(
          { ...stopped, items: [state.inFlight, ...state.items], inFlight: null },
          { announce: "Stopped message returned to the queue." },
        );
      }
      return result(stopped);
    }
    case "runStarted":
      return result({ ...state, stopRequested: false });
    case "runEnded": {
      const settled = { ...state, stopRequested: false, inFlight: null };
      if (settled.items.length === 0) return result({ ...settled, pausedBy: null });
      const reason: PauseReason | null = state.stopRequested
        ? "stopped"
        : action.outcome === "done"
          ? null
          : action.outcome;
      if (reason) {
        return result({ ...settled, pausedBy: reason }, { announce: state.pausedBy ? null : "Queue paused." });
      }
      // Paused stays paused across a turn the user started some other way.
      if (settled.pausedBy) return result(settled);
      return dequeue(settled);
    }
    case "resume": {
      if (state.items.length === 0) return result({ ...state, pausedBy: null });
      // Mid-turn, resuming just lets the end of this turn send the next item.
      if (action.isRunning) return result({ ...state, pausedBy: null }, { announce: "Queue resumed." });
      // The server was busy: retry the failed message, then carry on.
      if (state.pausedBy === "busy" && action.canRetry) {
        return result({ ...state, pausedBy: null }, { retry: true, announce: "Retrying." });
      }
      return dequeue(state);
    }
    case "clear":
      return result({ ...initialQueueState, nextId: state.nextId, announcementSeq: state.announcementSeq });
  }
}

// Holds the queue state outside React so each transition (and the send it
// triggers) happens exactly once, even when an effect runs twice. Components
// read it with useSyncExternalStore.
export interface MessageQueueController {
  getState: () => MessageQueueState;
  dispatch: (action: QueueAction) => QueueResult;
  subscribe: (listener: () => void) => () => void;
}

export function createMessageQueueController(initial: MessageQueueState = initialQueueState): MessageQueueController {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = queueReducer(state, action);
      if (next.state !== state) {
        state = next.state;
        for (const listener of listeners) listener();
      }
      return next;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

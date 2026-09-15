"use client";

import { useLayoutEffect, useRef } from "react";
import { ListPlus, Pencil, Play, Send, Square, X } from "lucide-react";
import { isStopGuarded } from "./run-control";
import type { MessageQueueState } from "./message-queue";

const iconButton =
  "p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500";

// Prompt input area: queued-message strip, pending-snapshot chip, auto-growing
// textarea, and the send / queue and stop buttons. Submission and queue logic
// stay in the parent, which owns the thread.
export default function Composer({
  prompt, setPrompt, pendingImage, setPendingImage, isRunning, onSubmit, onStop,
  queue, onEditQueued, onRemoveQueued, onResumeQueue,
}: {
  prompt: string;
  setPrompt: (p: string) => void;
  pendingImage: string | null;
  setPendingImage: (img: string | null) => void;
  isRunning: boolean;
  // Sends when idle, queues while a turn runs.
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
  queue: MessageQueueState;
  // Returns false when the item could not be moved into the composer.
  onEditQueued: (id: number) => boolean;
  onRemoveQueued: (id: number) => void;
  onResumeQueue: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const stopFocusedRef = useRef(false);
  const runStartedAtRef = useRef<number | null>(null);

  // Auto-grow the textarea from its content, driven by the `prompt` value the
  // parent owns. Keying off the value (not the change event) means the height
  // also shrinks back when the parent clears the prompt after a send.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [prompt]);

  // Layout effect, not a passive one: the run start must be stamped before
  // the browser can deliver the second click of a double-click.
  useLayoutEffect(() => {
    runStartedAtRef.current = isRunning ? performance.now() : null;
    // The submit button just changed meaning (Send <-> Queue), or the focused
    // Stop button unmounted: hand focus back to the prompt so it is never
    // dropped to <body> and Enter/Space can't trigger an unintended action.
    const stopLostFocus = !isRunning && stopFocusedRef.current;
    if (document.activeElement === submitButtonRef.current || stopLostFocus) {
      stopFocusedRef.current = false;
      textareaRef.current?.focus();
    }
  }, [isRunning]);

  const handleStop = () => {
    if (isStopGuarded(performance.now(), runStartedAtRef.current)) return;
    onStop();
  };

  const focusPrompt = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  const hasContent = Boolean(prompt.trim() || pendingImage);
  const { items, pausedBy } = queue;

  return (
    <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-2">
      {/* Always mounted so screen readers pick up each change. The sequence
          number is the key, so a repeated message is announced again. */}
      <div role="status" aria-live="polite" className="sr-only">
        {queue.announcement && <span key={queue.announcementSeq}>{queue.announcement}</span>}
      </div>

      {items.length > 0 && (
        <section
          aria-labelledby="queued-messages-label"
          className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950/60"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-gray-200 dark:border-gray-800">
            <p id="queued-messages-label" className="text-xs font-medium text-gray-700 dark:text-gray-200">
              Queued ({items.length})
            </p>
            {pausedBy ? (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                Paused {pausedBy === "error" ? "after an error" : "after Stop"}
              </span>
            ) : (
              <span className="text-xs text-gray-500 dark:text-gray-400">Sends when the reply finishes</span>
            )}
            {pausedBy && (
              <button
                type="button"
                onClick={() => {
                  onResumeQueue();
                  focusPrompt();
                }}
                title={isRunning ? "Send the queue when this reply finishes" : "Send the next queued message now"}
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-primary-700 dark:text-primary-300 hover:bg-primary-50 dark:hover:bg-primary-950/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <Play className="w-3.5 h-3.5" aria-hidden />
                {isRunning ? "Resume" : "Send next"}
              </button>
            )}
          </div>
          <ol className="max-h-40 overflow-y-auto divide-y divide-gray-200 dark:divide-gray-800">
            {items.map((item, index) => {
              const position = index + 1;
              const label = item.text.trim() || "Snapshot only";
              return (
                <li key={item.id} className="flex items-center gap-2 pl-3 pr-1 py-0.5">
                  <span className="text-xs tabular-nums text-gray-400 dark:text-gray-500" aria-hidden>
                    {position}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-700 dark:text-gray-200" title={item.text}>
                    {label}
                  </span>
                  {item.image && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-800 text-[11px] text-gray-600 dark:text-gray-300">
                      Snapshot
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (onEditQueued(item.id)) focusPrompt();
                    }}
                    aria-label={`Edit queued message ${position}`}
                    title="Edit"
                    className={iconButton}
                  >
                    <Pencil className="w-4 h-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onRemoveQueued(item.id);
                      focusPrompt();
                    }}
                    aria-label={`Remove queued message ${position}`}
                    title="Remove"
                    className={iconButton}
                  >
                    <X className="w-4 h-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {pendingImage && (
        <div className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
          {/* eslint-disable-next-line @next/next/no-img-element -- runtime data-URL snapshot, next/image can't optimize it */}
          <img src={pendingImage} alt="Snapshot to send" className="h-12 w-auto rounded object-contain" />
          <span className="text-xs text-gray-500 dark:text-gray-400 flex-1">Snapshot attached</span>
          <button
            onClick={() => setPendingImage(null)}
            className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            aria-label="Remove snapshot"
          >
            <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          </button>
        </div>
      )}
      <form onSubmit={onSubmit} className="flex gap-2 items-end">
        {/* Stays editable while a turn runs: sending then queues the message. */}
        <textarea
          ref={textareaRef}
          className="flex-1 min-w-0 px-4 py-3 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-primary-500 focus:outline-none transition-all resize-none min-h-[48px] max-h-[200px] overflow-y-auto scrollbar-hide"
          placeholder={
            isRunning
              ? "Queue a follow-up..."
              : pendingImage
                ? "Describe what to change..."
                : "Describe what you want to create..."
          }
          aria-label="Prompt"
          aria-describedby={isRunning ? "composer-queue-hint" : undefined}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (hasContent) onSubmit(e as unknown as React.FormEvent);
            }
          }}
          rows={1}
        />
        {isRunning && (
          <span id="composer-queue-hint" className="sr-only">
            A reply is in progress. Sending adds your message to the queue.
          </span>
        )}
        {/* Stop sits left of the submit button so a double-click on Send lands
            on the (now empty, disabled) Queue button, never on Stop. Stop also
            ignores clicks right after the run starts. */}
        {isRunning && (
          <button
            type="button"
            onClick={handleStop}
            onFocus={() => {
              stopFocusedRef.current = true;
            }}
            onBlur={() => {
              stopFocusedRef.current = false;
            }}
            aria-label="Stop generation"
            title="Stop generation"
            className="flex items-center justify-center gap-1.5 px-3 h-[48px] min-w-[48px] rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-950/70 text-red-600 dark:text-red-400 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            <Square className="w-4 h-4 fill-current" aria-hidden />
            Stop
          </button>
        )}
        {/* One submit element that changes role (Send when idle, Queue while a
            turn runs), never unmounted so focus is never dropped. */}
        <button
          ref={submitButtonRef}
          type="submit"
          disabled={!hasContent}
          aria-label={isRunning ? "Queue message" : "Send message"}
          title={isRunning ? "Queue message (sent when the reply finishes)" : "Send message"}
          className={
            isRunning
              ? "flex items-center justify-center min-w-[48px] h-[48px] p-3 rounded-xl border border-primary-300 dark:border-primary-800 bg-primary-50 dark:bg-primary-950/40 hover:bg-primary-100 dark:hover:bg-primary-950/70 text-primary-700 dark:text-primary-300 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400 dark:disabled:border-gray-800 dark:disabled:bg-gray-800 dark:disabled:text-gray-500 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              : "bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white p-3 rounded-xl transition-all shadow-sm hover:shadow-md flex items-center justify-center min-w-[48px] h-[48px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
          }
        >
          {isRunning ? <ListPlus className="w-5 h-5" aria-hidden /> : <Send className="w-5 h-5" aria-hidden />}
        </button>
      </form>
    </div>
  );
}

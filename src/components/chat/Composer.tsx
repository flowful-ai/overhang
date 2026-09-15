"use client";

import { useLayoutEffect, useRef } from "react";
import { Send, Square, X } from "lucide-react";
import { isStopGuarded } from "./run-control";

// Prompt input area: pending-snapshot chip, auto-growing textarea, and the
// send / stop button. Submission logic stays in the parent, which owns the thread.
export default function Composer({
  prompt, setPrompt, pendingImage, setPendingImage, isRunning, onSubmit, onStop,
}: {
  prompt: string;
  setPrompt: (p: string) => void;
  pendingImage: string | null;
  setPendingImage: (img: string | null) => void;
  isRunning: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onStop: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const runStartedAtRef = useRef<number | null>(null);

  // Auto-grow the textarea from its content, driven by the `prompt` value the
  // parent owns. Keying off the value (not the change event) means the height
  // also shrinks back when the parent clears the prompt after a send — the old
  // imperative onChange-only resize left an empty textarea stuck at its grown
  // height.
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
    // The button under focus just changed meaning (Send <-> Stop): hand focus
    // back to the prompt so Enter/Space can't trigger the opposite action.
    if (document.activeElement === runButtonRef.current) textareaRef.current?.focus();
  }, [isRunning]);

  const handleStop = () => {
    if (isStopGuarded(performance.now(), runStartedAtRef.current)) return;
    onStop();
  };

  return (
    <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-2">
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
        {/* Stays editable while a turn runs so the next prompt can be drafted;
            only sending is blocked (Enter and the submit handler both check). */}
        <textarea
          ref={textareaRef}
          className="flex-1 px-4 py-3 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-primary-500 focus:outline-none transition-all resize-none min-h-[48px] max-h-[200px] overflow-y-auto scrollbar-hide"
          placeholder={pendingImage ? "Describe what to change..." : "Describe what you want to create..."}
          aria-label="Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (isRunning) return;
              if (prompt.trim() || pendingImage) {
                onSubmit(e as unknown as React.FormEvent);
              }
            }
          }}
          rows={1}
        />
        {/* The single run control: Send when idle, Stop while generating. One
            element that changes role (never unmounted, so focus is never
            dropped to <body>); Stop ignores clicks right after the run starts
            so a double-click on Send can't cancel it. */}
        <button
          ref={runButtonRef}
          type={isRunning ? "button" : "submit"}
          onClick={isRunning ? handleStop : undefined}
          disabled={!isRunning && !prompt.trim() && !pendingImage}
          aria-label={isRunning ? "Stop generation" : "Send message"}
          title={isRunning ? "Stop generation" : "Send message"}
          className={
            isRunning
              ? "flex items-center justify-center gap-1.5 px-3 h-[48px] min-w-[48px] rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-950/70 text-red-600 dark:text-red-400 text-sm font-medium transition-colors"
              : "bg-primary-600 hover:bg-primary-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white p-3 rounded-xl transition-all shadow-sm hover:shadow-md flex items-center justify-center min-w-[48px] h-[48px]"
          }
        >
          {isRunning ? (
            <>
              <Square className="w-4 h-4 fill-current" aria-hidden />
              Stop
            </>
          ) : (
            <Send className="w-5 h-5" aria-hidden />
          )}
        </button>
      </form>
    </div>
  );
}

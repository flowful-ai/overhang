import { useEffect, useRef } from "react";
import type { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import type { ThreadMessage } from "@assistant-ui/react";
import { STORAGE_KEY } from "../constants";
import { createOnceReporter, saveThread, toRepository, type SaveOutcome } from "../persisted-state";

interface UseChatPersistenceArgs {
  runtime: ReturnType<typeof useChatRuntime>;
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  model: string;
  setModel: (m: string) => void;
  // Called at most once per mount when a save fails (quota, storage blocked).
  onPersistError?: (message: string) => void;
}

/**
 * Owns localStorage hydration + writes for the chat thread. Hydrates once on
 * mount; writes (throttled by a 1s timer) whenever the thread changes and is
 * not actively streaming. The stored shape is the runtime's message repository
 * reduced to its active branch (see persisted-state.ts), minus STL bytes and
 * all but the newest snapshot.
 *
 * Returns a clearPersisted() callback for "New chat" flows.
 */
export function useChatPersistence({
  runtime,
  messages,
  isRunning,
  model,
  setModel,
  onPersistError,
}: UseChatPersistenceArgs): { clearPersisted: () => void } {
  // Hydration runs exactly once. Tracked with a ref because the runtime
  // identity is stable but the effect runs in strict-mode double-invocation
  // during dev.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const state = JSON.parse(saved);
      if (typeof state.model === "string") setModel(state.model);
      // importExternalState takes the repository shape; a bare message array
      // (what this hook used to write) is linked into one.
      const repo = toRepository(state.messages);
      if (repo) runtime.thread.importExternalState(repo);
    } catch {
      // Corrupt data, ignore
    }
  }, [runtime, setModel]);

  const onPersistErrorRef = useRef(onPersistError);
  useEffect(() => {
    onPersistErrorRef.current = onPersistError;
  }, [onPersistError]);
  const reportFailureRef = useRef<((err: unknown) => void) | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist messages + model. Skipped while the agent is streaming (tokens
  // fire this effect dozens of times per second otherwise); the 1s timer
  // collapses bursts after the stream completes.
  useEffect(() => {
    if (messages.length === 0 || isRunning) return;
    const timer = setTimeout(() => {
      saveTimerRef.current = null;
      let exported: unknown;
      try {
        exported = runtime.thread.exportExternalState();
      } catch {
        return;
      }
      let outcome: SaveOutcome;
      try {
        // Reading `localStorage` itself throws when site data is blocked.
        outcome = saveThread(localStorage, exported, model);
      } catch (err) {
        outcome = { status: "failed", error: err };
      }
      if (outcome.status !== "failed") return;
      reportFailureRef.current ??= createOnceReporter((message) => onPersistErrorRef.current?.(message));
      reportFailureRef.current(outcome.error);
    }, 1000);
    saveTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (saveTimerRef.current === timer) saveTimerRef.current = null;
    };
  }, [messages, isRunning, model, runtime]);

  // Also drops a save still pending from the pre-reset thread, so it cannot
  // write the old conversation back after the storage is cleared.
  const clearPersisted = () => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  return { clearPersisted };
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { addToast, toastDuration, type ToastItem, type ToastVariant } from "./toast-list";

// Minimal in-house toast system. The app's single pattern for transient
// feedback (UX audit #8). Every toast has a manual close button and
// auto-dismisses after 4s, unless raised as persistent: errors the user has to
// act on stay until dismissed, so they can't vanish before they are read.
// The list rules live in toast-list.ts.

export type { ToastVariant };

export interface ToastOptions {
  persistent?: boolean;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Mirrors `toasts` so toast() can dedupe against the current list and know
  // which toast's timer to (re)start, outside a state updater.
  const listRef = useRef<ToastItem[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timersRef.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      listRef.current = listRef.current.filter((t) => t.id !== id);
      setToasts(listRef.current);
    },
    [clearTimer],
  );

  const toast = useCallback(
    (message: string, variant: ToastVariant = "error", options?: ToastOptions) => {
      const { list, shown } = addToast(
        listRef.current,
        { message, variant, persistent: !!options?.persistent },
        nextId.current++,
      );
      listRef.current = list;
      setToasts(list);
      // A repeat restarts the clock of the toast it merged into.
      clearTimer(shown.id);
      const duration = toastDuration(shown);
      if (duration !== null) timersRef.current.set(shown.id, setTimeout(() => dismiss(shown.id), duration));
    },
    [clearTimer, dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Above the code-editor modal (z-50) so feedback is never buried. */}
      <div
        aria-live="polite"
        className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg shadow-lg border text-sm animate-in fade-in slide-in-from-top-2 ${
              t.variant === "error"
                ? "bg-red-50 dark:bg-red-950/90 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300"
                : "bg-green-50 dark:bg-green-950/90 border-green-200 dark:border-green-900 text-green-700 dark:text-green-300"
            }`}
          >
            {t.variant === "error" ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : (
              <Check className="w-4 h-4 shrink-0" />
            )}
            <span className="max-w-[70vw] sm:max-w-md">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

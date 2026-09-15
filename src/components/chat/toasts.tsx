"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, X } from "lucide-react";

// Minimal in-house toast system. The app's single pattern for transient
// feedback (UX audit #8). Every toast auto-dismisses after 4s AND has a manual
// close button; errors and successes only, no persistent variants.

const TOAST_DURATION_MS = 4000;

export type ToastVariant = "error" | "success";

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = "error") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant }]);
      setTimeout(() => dismiss(id), TOAST_DURATION_MS);
    },
    [dismiss],
  );

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

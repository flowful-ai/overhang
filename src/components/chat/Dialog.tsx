"use client";

import { useEffect, useRef, type ReactNode } from "react";

// Elements a Tab trap should treat as stops. Matches the selector every
// other focus-management helper in the app would reach for.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Hand-rolled accessible dialog (no dep): `role="dialog"`, focus moved in on
 * open and restored to the trigger on close, Tab/Shift+Tab trapped inside
 * the panel, Escape and a backdrop click both close it (UX audit #9, #15).
 * Every modal-like surface in the app should render through this instead of
 * a one-off `fixed inset-0` div.
 */
export default function Dialog({
  open,
  onClose,
  labelledBy,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Move focus into the panel on open; restore it to whatever triggered the
  // dialog when it closes (or unmounts while still open).
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (firstFocusable ?? panel)?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  // Escape closes; Tab/Shift+Tab cycle within the panel instead of leaking
  // focus out to the page behind it.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // Let a composite editor that manages its own Tab key handle it (Monaco
      // uses Tab to indent). Trapping here would steal indentation and jump
      // focus to the next control instead.
      if ((document.activeElement as HTMLElement | null)?.closest(".monaco-editor")) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        // Only the backdrop itself closes, not clicks that bubble up from the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={className}
      >
        {children}
      </div>
    </div>
  );
}

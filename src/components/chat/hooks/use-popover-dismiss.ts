"use client";

import { useEffect, type RefObject } from "react";

/**
 * Dismisses a popover on a mousedown outside `ref` or an Escape keypress
 * while `open` is true. Shared by the header's model / settings
 * dropdowns and the viewer's export menu, so each popover owns its full
 * dismissal behavior in a single line.
 *
 * Escape deliberately doesn't stop propagation: <Dialog> handles its own
 * Escape independently (as it did when the parent owned popover Escape),
 * and only one popover is ever open at a time because any mousedown outside
 * a popover closes it before another can open.
 *
 * `onDismiss` should be referentially stable (a `useState` setter or a
 * `useCallback`) so the listeners aren't re-subscribed on every render.
 */
export function usePopoverDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, ref, onDismiss]);
}

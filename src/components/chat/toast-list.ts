// The toast list's rules, kept pure so they are unit-tested without a DOM
// (toast-list.test.ts). toasts.tsx owns the timers and the rendering.

export const TOAST_DURATION_MS = 4000;

export type ToastVariant = "error" | "success";

export interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  // Stays until dismissed: for errors the user has to act on (a failed render
  // or export, storage full). Transient notices auto-dismiss.
  persistent: boolean;
}

export type ToastInput = Omit<ToastItem, "id">;

/**
 * Adds a toast, or reuses the one already showing the same message and
 * variant, so a repeat doesn't stack. A persistent repeat makes the existing
 * toast persistent. Returns the list and the toast now on screen, whose
 * dismiss timer the caller (re)starts.
 */
export function addToast(list: readonly ToastItem[], input: ToastInput, id: number): { list: ToastItem[]; shown: ToastItem } {
  const existing = list.find((t) => t.variant === input.variant && t.message === input.message);
  if (!existing) {
    const shown = { id, ...input };
    return { list: [...list, shown], shown };
  }
  if (!input.persistent || existing.persistent) return { list: [...list], shown: existing };
  const shown = { ...existing, persistent: true };
  return { list: list.map((t) => (t === existing ? shown : t)), shown };
}

/** How long the toast stays up, or null to keep it until dismissed. */
export function toastDuration(item: Pick<ToastItem, "persistent">): number | null {
  return item.persistent ? null : TOAST_DURATION_MS;
}

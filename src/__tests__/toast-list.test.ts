import { describe, it, expect } from "vitest";
import { TOAST_DURATION_MS, addToast, toastDuration, type ToastInput } from "@/components/chat/toast-list";

const transient: ToastInput = { message: "A render is already in progress", variant: "error", persistent: false };
const sticky: ToastInput = { message: "3MF export failed", variant: "error", persistent: true };

describe("addToast", () => {
  it("appends a new toast with the given id", () => {
    const { list, shown } = addToast([], transient, 7);
    expect(shown).toEqual({ id: 7, ...transient });
    expect(list).toEqual([shown]);
  });

  it("does not stack a repeat: it returns the toast already shown, so its timer restarts", () => {
    const first = addToast([], transient, 1);
    const repeat = addToast(first.list, transient, 2);
    expect(repeat.list).toHaveLength(1);
    expect(repeat.shown.id).toBe(1);
  });

  it("keeps the same message under another variant as a separate toast", () => {
    const first = addToast([], transient, 1);
    const other = addToast(first.list, { ...transient, variant: "success" }, 2);
    expect(other.list).toHaveLength(2);
    expect(other.shown.id).toBe(2);
  });

  it("makes a transient toast persistent when it repeats as persistent", () => {
    const first = addToast([], { ...sticky, persistent: false }, 1);
    const repeat = addToast(first.list, sticky, 2);
    expect(repeat.list).toEqual([{ id: 1, ...sticky }]);
    expect(repeat.shown.persistent).toBe(true);
  });

  it("never downgrades a persistent toast", () => {
    const first = addToast([], sticky, 1);
    const repeat = addToast(first.list, { ...sticky, persistent: false }, 2);
    expect(repeat.shown.persistent).toBe(true);
  });

  it("does not mutate the input list", () => {
    const first = addToast([], transient, 1);
    const before = [...first.list];
    addToast(first.list, sticky, 2);
    expect(first.list).toEqual(before);
  });
});

describe("toastDuration", () => {
  it("auto-dismisses transient toasts and keeps persistent ones", () => {
    expect(toastDuration({ persistent: false })).toBe(TOAST_DURATION_MS);
    expect(toastDuration({ persistent: true })).toBeNull();
  });
});

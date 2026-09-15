"use client";

import { Loader2, RefreshCw } from "lucide-react";

/**
 * Shared "Re-render" trigger. One verb, one dirty-indicator style (a `*`
 * suffix), used by every render surface: the inline code block (live and
 * historical), the parameters panel, and the code-editor modal (UX audit
 * #5). Each call site supplies its own `className`/`iconClassName` to match
 * its surrounding layout; this component only owns the label/icon/spinner
 * logic so relabeling never again means touching every call site.
 */
export default function RerenderButton({
  onClick,
  isRendering,
  disabled,
  dirty,
  title,
  className,
  iconClassName = "w-3 h-3",
  disabledLabel,
}: {
  onClick: () => void;
  isRendering: boolean;
  disabled?: boolean;
  dirty?: boolean;
  title?: string;
  className: string;
  iconClassName?: string;
  // Shown in place of "Re-render" when the button is disabled and not
  // mid-render, so a call site can explain the greyed-out state (e.g. the
  // parameters panel's "No changes" instead of an actionable-looking label).
  disabledLabel?: string;
}) {
  const label = isRendering
    ? "Rendering..."
    : disabled && !dirty && disabledLabel
      ? disabledLabel
      : dirty
        ? "Re-render *"
        : "Re-render";
  return (
    <button onClick={onClick} disabled={disabled} title={title} className={className}>
      {isRendering ? (
        <Loader2 className={`${iconClassName} animate-spin`} />
      ) : (
        <RefreshCw className={iconClassName} />
      )}
      {label}
    </button>
  );
}

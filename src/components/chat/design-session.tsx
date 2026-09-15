"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { ThreadMessage } from "@assistant-ui/react";
import { postJson } from "./api";
import { deriveCurrentDesign } from "./hooks/use-current-design";
import { stepAutoRerender } from "./auto-rerender";

// The design the user is looking at across one thread. See CONTEXT.md:
// - current design: derived from the latest successful runCadquery tool call
// - working copy:   the user's editable code + its preview STL, on top
// - basis:          working copy when modified, else current design
// What a rerender() call amounted to. Callers that trigger side effects (close
// a modal, export a file) need to distinguish "a fresh preview STL was
// applied" from "busy, try later", "the design moved on underneath", and "the
// render failed (already surfaced via onError)" — a boolean conflated these
// and made call sites re-derive the session's busy state.
//
// The success case carries the code that was ACTUALLY rendered: the render
// loop below follows the working copy if the user keeps editing mid-flight,
// so it can settle on newer code than the caller held when it awaited. A
// caller that then acts on its own stale snapshot (e.g. exporting a 3MF of
// pre-drag geometry) would defeat the very freshness check it awaited.
export type RerenderResult =
  | { outcome: "rendered"; code: string }
  | { outcome: "busy" | "superseded" | "failed" };

export interface DesignSession {
  currentCode: string;
  currentStl: string | null;
  latestToolMessageId: string | null;
  workingCode: string;
  setWorkingCode: (code: string) => void;
  displayedStl: string | null;
  isRendering: boolean;
  isModified: boolean;
  // Hydrated thread: has code but no STL (persistence strips it), so the viewer
  // must offer a re-render. Not the same as an in-flight agent turn.
  needsRerender: boolean;
  // The automatic re-render of a restored thread ran and the viewer still has
  // no STL: offer a manual Re-render.
  restoreFailed: boolean;
  // Re-render the working copy through /api/render-cad.
  rerender: () => Promise<RerenderResult>;
  // New Chat: drop the working copy.
  reset: () => void;
}

interface BuildArgs {
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  // The transport is built once, above this provider, and reads the working
  // copy at send time to project it in as the basis (see next-turn.ts). The
  // session keeps this ref in sync off the render path.
  workingCodeRef: MutableRefObject<string>;
  onError: (msg: string) => void;
}

// Builds the session. Called once, inside the assistant-ui thread provider
// (it needs `messages`), then handed to <DesignSessionProvider>.
export function useProvideDesignSession({ messages, isRunning, workingCodeRef, onError }: BuildArgs): DesignSession {
  const { currentCode, currentStl, latestToolMessageId } = useMemo(
    () => deriveCurrentDesign(messages),
    [messages],
  );

  const [workingCode, setWorkingCode] = useState("");
  const [workingStl, setWorkingStl] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  // Synchronous double-click lock: setIsRendering only flips on the next render.
  const renderInFlightRef = useRef(false);

  // The ONLY writer of the working copy. The ref is written synchronously
  // alongside the state: an effect-mirror would lag a commit, leaving a window
  // where a render resolving between a slider edit and the effect run passes
  // the staleness guard in rerender() with a stale value.
  const setWorkingCodeSync = (code: string) => {
    workingCodeRef.current = code;
    setWorkingCode(code);
  };

  // The one reset invariant: when the agent emits new code, the working copy
  // follows it and the stale preview STL is dropped. Render-time adjustment
  // (React's "you might not need an effect") so the panes never paint a stale
  // copy. Only push truthy code into the buffer, matching the prior guard.
  // Seeded from "" (not currentCode) so a thread restored after mount seeds the
  // working copy on its first non-empty currentCode, independent of whether
  // hydration is sync or async.
  const [prevCode, setPrevCode] = useState("");
  if (currentCode !== prevCode) {
    setPrevCode(currentCode);
    setWorkingStl(null);
    // eslint-disable-next-line react-hooks/refs -- setWorkingCodeSync writes workingCodeRef, and the ref must not lag this state adjustment: rerender() compares against it to discard a render whose code has been superseded, and an effect-based mirror updates a commit too late (the window this closes). The write is idempotent in `currentCode`, so a discarded/replayed render re-derives the same value.
    if (currentCode) setWorkingCodeSync(currentCode);
  }

  // Latest agent code, readable inside the async render closure, to discard a
  // preview that resolves after the agent already moved on (the composer no
  // longer blocks submit during a re-render).
  const currentCodeRef = useRef(currentCode);
  useEffect(() => {
    currentCodeRef.current = currentCode;
  }, [currentCode]);

  const displayedStl = workingStl ?? currentStl;
  const isModified = workingCode !== currentCode && currentCode !== "";
  const needsRerender = messages.length > 0 && !displayedStl && !!currentCode && !isRunning;

  const rerender = async (): Promise<RerenderResult> => {
    if (isRunning || renderInFlightRef.current) return { outcome: "busy" };
    const codeAtStart = currentCodeRef.current;
    renderInFlightRef.current = true;
    setIsRendering(true);
    try {
      // Always render the NEWEST working copy, looping when it changes while
      // a request is in flight (sliders stay enabled and commit on every
      // input event): a stale STL must never land, and the spinner must not
      // finish leaving the viewer showing pre-edit geometry. Edits arriving
      // during one round-trip coalesce — the next iteration reads only the
      // latest value — so this is one render per round-trip, not one per
      // edit, and it settles one round-trip after the user stops.
      for (;;) {
        const code = workingCodeRef.current;
        if (!code.trim()) return { outcome: "failed" };
        let data: { stlBase64?: string } | undefined;
        try {
          data = await postJson<{ stlBase64?: string }>(
            "/api/render-cad",
            { code },
            "Failed to render model",
          );
        } catch (err: unknown) {
          // Staleness is checked on the failure path too: without this, a
          // failed render would report an error about code the user has
          // already replaced and stop, leaving the newest edit unrendered.
          if (currentCodeRef.current !== codeAtStart) return { outcome: "superseded" };
          if (workingCodeRef.current !== code) continue;
          onError(err instanceof Error ? err.message : "Re-render failed");
          return { outcome: "failed" };
        }
        // The agent moved on mid-flight: its new design owns the viewer now.
        if (currentCodeRef.current !== codeAtStart) return { outcome: "superseded" };
        if (workingCodeRef.current !== code) continue;
        if (data?.stlBase64) {
          setWorkingStl(data.stlBase64);
          return { outcome: "rendered", code };
        }
        // A 200 without geometry is still a failed render: surface it like
        // any other, or an automatic restore would fail silently.
        onError("The render finished without a model. Try Re-render again.");
        return { outcome: "failed" };
      }
    } finally {
      renderInFlightRef.current = false;
      setIsRendering(false);
    }
  };

  // Restored thread: re-render the latest code once so the viewer isn't left
  // empty. The guard (auto-rerender.ts) allows one attempt per current code
  // per page load and never fires while an STL is shown, so a failing render
  // toasts once and then waits for a manual Re-render instead of looping.
  const [autoRenderedCode, setAutoRenderedCode] = useState<string | null>(null);
  // rerender is a fresh closure every render; read the newest one through a
  // ref so the effect below only re-runs when its inputs change.
  const rerenderRef = useRef(rerender);
  useEffect(() => {
    rerenderRef.current = rerender;
  });
  useEffect(() => {
    const step = stepAutoRerender(
      { needsRerender, hasStl: !!displayedStl, isRendering, currentCode },
      autoRenderedCode,
    );
    if (!step.fire) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- records the one-shot guard in the same tick that starts the async render; it can't be derived during render because the render is a network side effect
    setAutoRenderedCode(step.attemptedCode);
    void rerenderRef.current();
  }, [needsRerender, displayedStl, isRendering, currentCode, autoRenderedCode]);
  const restoreFailed = needsRerender && !isRendering && autoRenderedCode === currentCode;

  const reset = () => {
    setWorkingCodeSync("");
    setWorkingStl(null);
  };

  return {
    currentCode,
    currentStl,
    latestToolMessageId,
    workingCode,
    setWorkingCode: setWorkingCodeSync,
    displayedStl,
    isRendering,
    isModified,
    needsRerender,
    restoreFailed,
    rerender,
    reset,
  };
}

const DesignSessionContext = createContext<DesignSession | null>(null);

export function DesignSessionProvider({ value, children }: { value: DesignSession; children: ReactNode }) {
  return <DesignSessionContext.Provider value={value}>{children}</DesignSessionContext.Provider>;
}

// Read the session from the three panes. The interface is the test surface.
export function useDesignSession(): DesignSession {
  const ctx = useContext(DesignSessionContext);
  if (!ctx) throw new Error("useDesignSession must be used within a DesignSessionProvider");
  return ctx;
}

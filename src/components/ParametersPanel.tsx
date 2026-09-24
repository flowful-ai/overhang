"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Sliders } from "lucide-react";
import { parseParameters, setParameter, type Parameter } from "@/lib/parameters";
import RerenderButton from "./chat/RerenderButton";

interface ParametersPanelProps {
  code: string;
  onCodeChange: (newCode: string) => void;
  onRerender: () => void;
  dirty: boolean;
  isRendering: boolean;
  disabled?: boolean;
  // Controlled by the parent so the open state survives remounts and the
  // panel can be opened automatically.
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

// Delay between committing a value (slider release, number input commit) and
// the re-render it triggers. Commits inside the window collapse into one
// request; edits landing while a request is in flight are picked up by the
// design session's render loop.
const COMMIT_RENDER_DELAY_MS = 250;

export default function ParametersPanel({
  code, onCodeChange, onRerender, dirty, isRendering, disabled, expanded, onExpandedChange,
}: ParametersPanelProps) {
  const params = useMemo(() => parseParameters(code), [code]);
  const idPrefix = useId();
  const contentId = `${idPrefix}-content`;

  // The timer fires after later renders: read the newest callback and
  // disabled flag, not the ones captured when the commit happened.
  const onRerenderRef = useRef(onRerender);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onRerenderRef.current = onRerender;
    disabledRef.current = disabled;
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  const scheduleRerender = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!disabledRef.current) onRerenderRef.current();
    }, COMMIT_RENDER_DELAY_MS);
  }, []);

  if (params.length === 0) return null;

  const handleValueChange = (name: string, value: number) => {
    onCodeChange(setParameter(code, name, value));
  };

  const rerenderDisabled = disabled || isRendering || !dirty;

  return (
    <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm select-none">
      <button
        onClick={() => onExpandedChange(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors rounded-lg"
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Sliders className="w-3.5 h-3.5" />
        <span>Parameters ({params.length}){dirty ? <span className="text-amber-500 ml-1">*</span> : null}</span>
      </button>
      {expanded && (
        <div id={contentId} className="border-t border-gray-100 dark:border-gray-800 w-[calc(100vw-4rem)] sm:w-72">
          <div className="p-2 max-h-[40dvh] sm:max-h-80 overflow-y-auto space-y-2">
            {params.map(p => (
              <SliderRow
                key={p.name}
                id={`${idPrefix}-${p.name}`}
                param={p}
                disabled={disabled}
                onChange={v => handleValueChange(p.name, v)}
                onCommit={scheduleRerender}
              />
            ))}
          </div>
          <div className="border-t border-gray-100 dark:border-gray-800 p-2">
            <RerenderButton
              onClick={onRerender}
              isRendering={isRendering}
              disabled={rerenderDisabled}
              dirty={dirty}
              disabledLabel="No changes"
              iconClassName="w-3.5 h-3.5"
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                rerenderDisabled
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                  : "bg-primary-600 hover:bg-primary-700 text-white shadow-sm"
              }`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// One parameter: a range slider plus a number input. Both update the working
// code live; the preview re-renders on commit (slider released, keyboard step,
// number input blurred or Enter), not on every intermediate value.
function SliderRow({
  id,
  param,
  onChange,
  onCommit,
  disabled,
}: {
  id: string;
  param: Parameter;
  onChange: (value: number) => void;
  onCommit: () => void;
  disabled?: boolean;
}) {
  const { name, value, unit, description, min, max, step, isInteger } = param;
  // Text of the number input while the user is typing, so a partial value
  // ("1" on the way to "12") isn't clamped out from under them.
  const [draft, setDraft] = useState<string | null>(null);
  // Whether the code changed since the last commit, so a click that doesn't
  // move the slider doesn't cost a render.
  const pendingRef = useRef(false);
  // The last value the preview was asked to render (set on focus and on each
  // commit). Escape reverts the code to it.
  const committedRef = useRef<number | null>(null);

  const clamp = (v: number) => {
    const clamped = Math.max(min, Math.min(max, v));
    return isInteger ? Math.round(clamped) : clamped;
  };

  // Writes the value into the code when it changed; returns the resulting value.
  const update = (v: number): number => {
    if (!Number.isFinite(v)) return value;
    const next = clamp(v);
    if (next === value) return value;
    pendingRef.current = true;
    onChange(next);
    return next;
  };

  const commitIfPending = (committed: number = value) => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    committedRef.current = committed;
    onCommit();
  };

  const commitDraft = () => {
    let committed = value;
    if (draft !== null) {
      committed = update(parseFloat(draft));
      setDraft(null);
    }
    commitIfPending(committed);
  };

  // Escape: in-range keystrokes were already written to the code, so clearing
  // the draft alone would leave (and later render) the escaped value. Put the
  // last committed value back and drop the pending render.
  const revertDraft = () => {
    const committed = committedRef.current;
    if (committed !== null && committed !== value) onChange(committed);
    pendingRef.current = false;
    setDraft(null);
  };

  const valueId = `${id}-value`;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={valueId}
          className="text-[11px] font-mono text-gray-700 dark:text-gray-200 truncate"
          title={description || name}
        >
          {name}
        </label>
        <div className="flex items-center gap-1">
          <input
            id={valueId}
            type="number"
            value={draft ?? value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onChange={e => {
              const text = e.target.value;
              setDraft(text);
              // Keep the code live for in-range values (spinner clicks,
              // arrow keys); out-of-range text waits for the commit clamp.
              const v = parseFloat(text);
              if (Number.isFinite(v) && v >= min && v <= max) update(v);
            }}
            onFocus={() => {
              if (!pendingRef.current) committedRef.current = value;
            }}
            onBlur={commitDraft}
            onPointerUp={() => commitIfPending()}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              } else if (e.key === "Escape") {
                revertDraft();
              }
            }}
            onKeyUp={e => {
              if (e.key === "ArrowUp" || e.key === "ArrowDown") commitIfPending();
            }}
            className="w-16 text-[11px] font-mono text-right px-1 py-0.5 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
          />
          {unit && <span className="text-[10px] text-gray-400 dark:text-gray-500 w-4 shrink-0">{unit}</span>}
        </div>
      </div>
      <input
        type="range"
        aria-label={name}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => update(parseFloat(e.target.value))}
        onPointerUp={() => commitIfPending()}
        onKeyUp={() => commitIfPending()}
        onBlur={() => commitIfPending()}
        className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}

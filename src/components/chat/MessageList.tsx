"use client";

import { useCallback, useEffect, useId, useRef, useState, memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ThreadMessage } from "@assistant-ui/react";
import {
  Loader2, Box, User, RefreshCw, ChevronDown, ChevronRight,
  Maximize2, AlertTriangle, Code2, Lightbulb,
} from "lucide-react";

import CodeEditor from "./lazy-code-editor";
import type { CadqueryToolResult } from "@/lib/cad-worker-protocol";
import { TOOL_NAME } from "./constants";
import RerenderButton from "./RerenderButton";
import { deriveAgentProgress } from "./agent-progress";
import { extractStreamingCode } from "./streaming-code";
import { useDesignSession } from "./design-session";
import { describeChatError, findRetryTarget } from "./chat-error";
import { OMITTED_SNAPSHOT_TEXT } from "./strip-images";
import { findSupersededAttempts } from "./tool-attempts";

// Starter prompts shown in the empty state. Kept in sync with the README's
// example table so first-time users have a one-click way to see the product
// work instead of facing a blank composer.
const EXAMPLE_PROMPTS = [
  "Box for a Pi 5, USB-C cutout, 3mm wall",
  "L-bracket, 60×40mm, 3 holes for M3 screws",
  "Cable clip for a 6mm bundle",
  "GoPro 1/4-20 tripod adapter",
];

// How close to the bottom (px) the chat must be scrolled for new content to
// keep it pinned there.
const AUTOSCROLL_THRESHOLD_PX = 80;

const MARKDOWN_COMPONENTS = {
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className="my-1.5 list-disc pl-5 space-y-0.5" {...props} />,
  ol: (props: React.OlHTMLAttributes<HTMLOListElement>) => <ol className="my-1.5 list-decimal pl-5 space-y-0.5" {...props} />,
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => <li className="leading-snug" {...props} />,
  strong: (props: React.HTMLAttributes<HTMLElement>) => <strong className="font-semibold text-gray-900 dark:text-gray-50" {...props} />,
  em: (props: React.HTMLAttributes<HTMLElement>) => <em className="italic" {...props} />,
  code: (props: React.HTMLAttributes<HTMLElement>) => (
    <code className="px-1 py-0.5 bg-primary-50 dark:bg-primary-950/40 text-primary-700 dark:text-primary-300 rounded text-[12px] font-mono" {...props} />
  ),
  blockquote: (props: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="my-1.5 pl-3 border-l-2 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300" {...props} />
  ),
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className="font-semibold text-gray-900 dark:text-gray-50 mt-2 mb-1 text-base" {...props} />,
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="font-semibold text-gray-900 dark:text-gray-50 mt-2 mb-1 text-sm" {...props} />,
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="font-semibold text-gray-900 dark:text-gray-50 mt-2 mb-1 text-sm" {...props} />,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary-600 dark:text-primary-400 underline hover:text-primary-700 dark:hover:text-primary-300" target="_blank" rel="noreferrer" {...props} />
  ),
};

const MarkdownPart = memo(function MarkdownPart({ text }: { text: string }) {
  return (
    <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

// A failed turn: friendly copy for the server/transport error (chat-error.ts)
// and, on the thread's last turn, a Retry that resends the last user message.
function TurnError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, retryable } = describeChatError(error);
  return (
    <div className="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900 text-red-600 dark:text-red-400 text-sm rounded-xl">
      <span className="flex-1 min-w-0 break-words">{message}</span>
      {onRetry && retryable && (
        <button
          onClick={onRetry}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-white dark:bg-gray-900 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/60 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}

const CollapsibleCodeBlock = memo(function CollapsibleCodeBlock({
  code, expanded, onToggle,
}: { code: string; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Code2 className="w-3.5 h-3.5" />
        <span>{expanded ? "Hide code" : "Show code"}</span>
      </button>
      {expanded && (
        <div className="h-52 overflow-hidden bg-[#1e1e1e]">
          <pre className="h-full overflow-auto p-3 text-[13px] leading-5 font-mono text-gray-300 whitespace-pre">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  );
});

// Stable fallback for the optional onRerender a non-live CodeSection never
// invokes (the button is only rendered when isLive), so callers that don't
// wire it up don't need to pass a dummy closure, and memo isn't defeated by
// a fresh closure identity on every parent render.
const NOOP = () => {};

const CodeSection = memo(function CodeSection({
  code, isLive, editedCode, setEditedCode, expanded, partKey, onToggleExpanded,
  onRerender, isRendering, isLoading, title, modified, onExpand,
}: {
  code: string;
  isLive: boolean;
  editedCode: string;
  setEditedCode: (c: string) => void;
  expanded: boolean;
  partKey: string;
  onToggleExpanded: (key: string) => void;
  onRerender?: () => void;
  isRendering?: boolean;
  isLoading?: boolean;
  // Distinguishes historical versions from the live one in a tooltip; the
  // visible label is always "Re-render" (UX audit #5).
  title?: string;
  modified?: boolean;
  onExpand?: () => void;
}) {
  const disabled = !!isRendering || !!isLoading;
  const handleToggle = useCallback(() => onToggleExpanded(partKey), [onToggleExpanded, partKey]);
  return (
    <div className="space-y-2">
      {isLive ? (
        <div className="h-52 border rounded-lg overflow-hidden bg-[#1e1e1e]">
          <CodeEditor code={editedCode} onChange={(val) => setEditedCode(val || "")} readOnly={false} />
        </div>
      ) : (
        <CollapsibleCodeBlock code={code} expanded={expanded} onToggle={handleToggle} />
      )}
      {isLive && (
        <div className="flex items-center gap-2">
          <RerenderButton
            onClick={onRerender ?? NOOP}
            isRendering={!!isRendering}
            disabled={disabled}
            dirty={modified}
            title={title}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              disabled ? "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed" : "bg-primary-600 hover:bg-primary-700 text-white shadow-sm"
            }`}
          />
          {onExpand && (
            <button
              onClick={onExpand}
              className="p-1.5 rounded-lg text-xs font-medium transition-all bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200"
              aria-label="Expand code editor"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

// A failed render that a later render in the same message replaced
// (tool-attempts.ts). Collapsed by default so a retry that worked doesn't
// read as a failure or show near-identical code twice.
// The row's own disclosure shares expandedCodeIds with its code block, under
// a distinct key.
const attemptRowKey = (partKey: string) => `${partKey}-attempt`;

const SupersededAttempt = memo(function SupersededAttempt({
  attempt, error, code, partKey, expanded, codeExpanded, onToggleExpanded,
}: {
  attempt: number;
  error?: string;
  code: string;
  partKey: string;
  expanded: boolean;
  codeExpanded: boolean;
  onToggleExpanded: (key: string) => void;
}) {
  const rowKey = attemptRowKey(partKey);
  const panelId = useId();
  const handleToggle = useCallback(() => onToggleExpanded(rowKey), [onToggleExpanded, rowKey]);
  const handleToggleCode = useCallback(() => onToggleExpanded(partKey), [onToggleExpanded, partKey]);
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" aria-hidden />
        <span>Attempt {attempt} failed, retried automatically</span>
      </button>
      <div id={panelId} hidden={!expanded} className="px-3 pb-3 space-y-2">
        {error && (
          <p className="text-xs text-amber-700 dark:text-amber-300 break-words">{error}</p>
        )}
        {code && (
          <CollapsibleCodeBlock code={code} expanded={codeExpanded} onToggle={handleToggleCode} />
        )}
      </div>
    </div>
  );
});

const WarningsCard = memo(function WarningsCard({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/40 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-200 dark:border-amber-900 bg-amber-100/50 dark:bg-amber-900/40">
        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-semibold text-amber-800 dark:text-amber-100">Design review</span>
      </div>
      <ul className="px-3 py-2 space-y-1">
        {warnings.map((w, i) => (
          <li key={i} className="text-xs text-amber-900 dark:text-amber-100 flex gap-2">
            <span className="text-amber-500 dark:text-amber-400 shrink-0">•</span>
            <span>{w}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

// The scrollable conversation: empty-state examples, the session-restored
// banner, user/assistant messages (text, tool-call code sections, errors),
// and the running indicator. Stop lives in the composer.
export default function MessageList({
  messages, isRunning, onExample, onRetry, onOpenCodeModal,
}: {
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  onExample: (text: string) => void;
  onRetry: () => void;
  onOpenCodeModal: () => void;
}) {
  const {
    latestToolMessageId, restoreFailed,
    workingCode, setWorkingCode, isRendering, isModified, rerender,
  } = useDesignSession();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Only the thread's final failed turn offers Retry.
  const retryMessageId = findRetryTarget(messages, isRunning) ? messages[messages.length - 1].id : null;

  // Which historical code blocks are expanded, keyed by `${messageId}-${idx}`.
  // Purely list-local UI state, so it lives here rather than in the parent.
  const [expandedCodeIds, setExpandedCodeIds] = useState<Set<string>>(new Set());

  const onToggleCodeExpanded = useCallback((id: string) => {
    setExpandedCodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // New Chat empties the thread without unmounting this component; clear the
  // expansion set then (the parent's reset used to do this) so stale keys
  // can't leak into a future conversation. Render-time adjustment, not an
  // effect, so it never commits a paint with the stale set.
  if (messages.length === 0 && expandedCodeIds.size > 0) {
    setExpandedCodeIds(new Set());
  }

  // Follow the conversation, but only while the user is at (or near) the
  // bottom: streamed tokens must not yank someone reading an earlier message
  // back down. A message the user just sent always scrolls into view.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // Our own scrolls only ever move down, so only an upward scroll (the user)
  // can stop the following; getting back near the bottom resumes it. This
  // needs no scrollend event to tell our smooth scroll apart from the user's
  // (Safari lacks it, and a scroll that moves nothing never fires it).
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= AUTOSCROLL_THRESHOLD_PX) {
      nearBottomRef.current = true;
    } else if (el.scrollTop < lastScrollTopRef.current) {
      nearBottomRef.current = false;
    }
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  const firstScrollRef = useRef(true);
  const prevCountRef = useRef(messages.length);
  useEffect(() => {
    const isNewMessage = messages.length !== prevCountRef.current;
    prevCountRef.current = messages.length;
    // A restored thread is imported after mount, so the list first renders
    // empty: keep the first real scroll instant rather than animating through
    // the whole history.
    if (messages.length === 0) {
      firstScrollRef.current = true;
      return;
    }
    const userJustSent = isNewMessage && messages[messages.length - 1]?.role === "user";
    if (!firstScrollRef.current && !userJustSent && !nearBottomRef.current) return;
    // Smooth only for a new message; streamed tokens jump, so the view keeps
    // up without a long-running animation.
    const smooth = !firstScrollRef.current && isNewMessage;
    firstScrollRef.current = false;
    nearBottomRef.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "instant" });
  }, [messages]);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4"
    >
      {messages.length === 0 && (
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-4 bg-primary-50 dark:bg-primary-950/40 rounded-xl">
            <div className="p-2 bg-primary-100 dark:bg-primary-900/40 rounded-full shrink-0">
              <Box className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            </div>
            <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
              Describe the 3D object you want to create. Typically geometric shapes and mechanical parts work best.
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-gray-400 dark:text-gray-500">
              <Lightbulb className="w-3.5 h-3.5" />
              <span>Try an example</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLE_PROMPTS.map((ex) => (
                <button
                  key={ex}
                  onClick={() => onExample(ex)}
                  disabled={isRunning}
                  className="text-left text-xs px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:border-primary-300 hover:bg-primary-50 dark:hover:bg-primary-950/40 hover:text-primary-700 dark:hover:text-primary-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* A restored session re-renders on its own; this only shows when that
          automatic attempt failed. */}
      {restoreFailed && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300 text-sm rounded-xl">
          <RefreshCw className="w-4 h-4 shrink-0" />
          <span>Couldn&apos;t reload your model. Click <strong>Re-render</strong> to try again.</span>
        </div>
      )}

      {messages.map((message) => {
        if (message.role === "user") {
          const textParts = message.content.filter((p) => p.type === "text") as { text: string }[];
          // Older snapshots are dropped from history (strip-images.ts) and
          // leave a placeholder part: show a marker, not the raw placeholder.
          const snapshotOmitted = textParts.some((p) => p.text === OMITTED_SNAPSHOT_TEXT);
          const text = textParts
            .filter((p) => p.text !== OMITTED_SNAPSHOT_TEXT)
            .map((p) => p.text)
            .join("\n");
          // The AI SDK runtime surfaces user file parts as attachments.
          const image = (message.content.find((p) => p.type === "image")
            ?? message.attachments?.flatMap((a) => a.content).find((p) => p.type === "image")) as
            | { image: string }
            | undefined;
          return (
            <div key={message.id} className="animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-gray-200 dark:bg-gray-700 rounded-full shrink-0">
                  <User className="w-4 h-4 text-gray-600 dark:text-gray-300" />
                </div>
                <div className="flex-1 min-w-0 bg-gray-100 dark:bg-gray-800 rounded-xl p-3 space-y-2">
                  {image && (
                    // eslint-disable-next-line @next/next/no-img-element -- runtime data-URL snapshot, next/image can't optimize it
                    <img
                      src={image.image}
                      alt="Model snapshot"
                      className="rounded-lg max-w-full h-auto max-h-32 object-contain"
                    />
                  )}
                  {snapshotOmitted && !image && (
                    <p className="text-[11px] italic text-gray-400 dark:text-gray-500">Snapshot not kept in history</p>
                  )}
                  <p className="text-sm text-gray-800 dark:text-gray-100 break-words">{text}</p>
                </div>
              </div>
            </div>
          );
        }

        // Assistant: render text + tool calls
        const hasError = message.status?.type === "incomplete" && message.status.reason === "error";
        const hasContent = message.content.some((part) => {
          if (part.type === "text") return !!part.text;
          if (part.type === "tool-call") {
            const partArgs = (part.args as { code?: string } | undefined)?.code
              ?? extractStreamingCode(part.argsText ?? "");
            return !!(part.result || partArgs);
          }
          return false;
        });
        if (!hasError && !hasContent) return null;
        const supersededAttempts = findSupersededAttempts(message.content);
        return (
          <div key={message.id} className="animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-primary-100 dark:bg-primary-900/40 rounded-full shrink-0">
                <Box className="w-4 h-4 text-primary-600 dark:text-primary-400" />
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                {message.content.map((part, idx) => {
                  if (part.type === "text") {
                    if (!part.text) return null;
                    return <MarkdownPart key={idx} text={part.text} />;
                  }
                  if (part.type === "tool-call" && part.toolName === TOOL_NAME) {
                    const result = part.result as CadqueryToolResult | undefined;
                    const argsCode = (part.args as { code?: string } | undefined)?.code
                      ?? extractStreamingCode(part.argsText ?? "");
                    const codeToShow = result?.code ?? argsCode ?? "";
                    const isLastCall = message.id === latestToolMessageId;
                    const partKey = `${message.id}-${idx}`;
                    const attempt = supersededAttempts.get(idx);
                    if (attempt !== undefined && result && !result.success) {
                      return (
                        <SupersededAttempt
                          key={idx}
                          attempt={attempt}
                          error={result.error}
                          code={codeToShow}
                          partKey={partKey}
                          expanded={expandedCodeIds.has(attemptRowKey(partKey))}
                          codeExpanded={expandedCodeIds.has(partKey)}
                          onToggleExpanded={onToggleCodeExpanded}
                        />
                      );
                    }
                    if (result && !result.success) {
                      return (
                        <div key={idx} className="space-y-2">
                          <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300 text-sm rounded-xl">
                            <strong>Render error: </strong>{result.error}
                          </div>
                          {codeToShow && (
                            <CodeSection
                              code={codeToShow}
                              isLive={false}
                              partKey={partKey}
                              editedCode=""
                              setEditedCode={setWorkingCode}
                              expanded={expandedCodeIds.has(partKey)}
                              onToggleExpanded={onToggleCodeExpanded}
                            />
                          )}
                        </div>
                      );
                    }
                    return (
                      <div key={idx} className="space-y-2">
                        {result?.warnings && result.warnings.length > 0 && (
                          <WarningsCard warnings={result.warnings} />
                        )}
                        {codeToShow && (
                          <CodeSection
                            code={codeToShow}
                            isLive={isLastCall}
                            partKey={partKey}
                            editedCode={isLastCall ? workingCode : ""}
                            setEditedCode={setWorkingCode}
                            expanded={expandedCodeIds.has(partKey)}
                            onToggleExpanded={onToggleCodeExpanded}
                            onRerender={isLastCall ? rerender : undefined}
                            isRendering={isLastCall ? isRendering : undefined}
                            isLoading={isLastCall ? isRunning : undefined}
                            title={isLastCall ? undefined : "Re-render this version"}
                            modified={isLastCall ? isModified : false}
                            onExpand={isLastCall ? onOpenCodeModal : undefined}
                          />
                        )}
                      </div>
                    );
                  }
                  return null;
                })}
                {message.status?.type === "incomplete" && message.status.reason === "error" && (
                  <TurnError
                    error={message.status.error}
                    onRetry={message.id === retryMessageId ? onRetry : undefined}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}

      {isRunning && (
        <div className="flex items-start gap-3 animate-in fade-in">
          <div className="p-2 bg-primary-100 dark:bg-primary-900/40 rounded-full shrink-0">
            <Box className="w-4 h-4 text-primary-600 dark:text-primary-400" />
          </div>
          <div className="flex items-center gap-3">
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              {(() => {
                const last = messages[messages.length - 1];
                return deriveAgentProgress(last?.role === "assistant" ? last.content : []);
              })()}
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}

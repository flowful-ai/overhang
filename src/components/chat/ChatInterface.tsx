"use client";

import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore, type MutableRefObject } from "react";
import {
  AssistantRuntimeProvider,
  useThread,
  useThreadRuntime,
} from "@assistant-ui/react";
import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { DefaultChatTransport, type UIMessage } from "ai";
import { RotateCcw } from "lucide-react";

import { APP_CONSTANTS, MODELS, ALLOWED_MODEL_IDS } from "@/lib/utils";
import { ToastProvider, useToasts } from "./toasts";
import { forNextTurn } from "./next-turn";
import { useProvideDesignSession, DesignSessionProvider } from "./design-session";
import { useChatPersistence } from "./hooks/use-chat-persistence";
import { findRetryTarget } from "./chat-error";
import Header from "./Header";
import MessageList from "./MessageList";
import Composer from "./Composer";
import ViewerPane from "./ViewerPane";
import CodeEditorModal from "./CodeEditorModal";
import NewChatConfirmDialog from "./NewChatConfirmDialog";
import { resetConversation } from "./reset-conversation";
import {
  MAX_QUEUED_MESSAGES,
  createMessageQueueController,
  outgoingText,
  turnFailed,
  validateOutgoing,
  type QueuedMessage,
} from "./message-queue";
import { loadWebSearchPreference, saveWebSearchPreference } from "./web-search-preference";

export default function ChatInterface({ webSearchAvailable }: { webSearchAvailable: boolean }) {
  const [model, setModel] = useState<string>(MODELS[0].id);
  // Read on first render: nothing rendered on the server depends on it (the
  // settings popover starts closed), so the server default cannot mismatch.
  const [webSearch, setWebSearchState] = useState<boolean>(() =>
    typeof window === "undefined" ? true : loadWebSearchPreference(),
  );
  const setWebSearch = useCallback((enabled: boolean) => {
    setWebSearchState(enabled);
    saveWebSearchPreference(enabled);
  }, []);
  // Refs the (stable) transport reads at send time, so changing them doesn't
  // recreate the transport (which would dump the runtime). Model and web search
  // are synced in an effect; the working copy is kept in sync by the design
  // session. forNextTurn projects the working copy in as the basis the agent
  // builds on.
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const webSearchRef = useRef(webSearch);
  useEffect(() => {
    webSearchRef.current = webSearch;
  }, [webSearch]);
  const workingCodeRef = useRef("");

  // Built once on purpose: the transport reads model + working copy from refs at
  // send time, so react-compiler cannot (and should not) re-memoize it.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- intentional stable transport; refs are read at send time, not memo time
  const transport = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- refs are read inside prepareSendMessagesRequest, a deferred callback invoked at send time, not during this memo
      new DefaultChatTransport<UIMessage>({
        api: "/api/generate-cad",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages: forNextTurn(messages, workingCodeRef.current),
            model: modelRef.current,
            webSearch: webSearchRef.current,
          },
        }),
      }),
    [],
  );

  const runtime = useChatRuntime({ transport });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ToastProvider>
        <ChatInterfaceInner
          model={model}
          setModel={setModel}
          webSearch={webSearch}
          setWebSearch={setWebSearch}
          webSearchAvailable={webSearchAvailable}
          runtime={runtime}
          workingCodeRef={workingCodeRef}
        />
      </ToastProvider>
    </AssistantRuntimeProvider>
  );
}

function ChatInterfaceInner({
  model, setModel, webSearch, setWebSearch, webSearchAvailable, runtime, workingCodeRef,
}: {
  model: string;
  setModel: (m: string) => void;
  webSearch: boolean;
  setWebSearch: (enabled: boolean) => void;
  webSearchAvailable: boolean;
  runtime: ReturnType<typeof useChatRuntime>;
  workingCodeRef: MutableRefObject<string>;
}) {
  const thread = useThread();
  const threadRuntime = useThreadRuntime();
  const messages = thread.messages;
  const isRunning = thread.isRunning;

  const { toast } = useToasts();

  const [prompt, setPrompt] = useState("");
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  // Mobile-only Chat/Model tab switch (UX audit #14). Desktop (md+) shows both
  // panels side by side and ignores this state.
  const [mobileTab, setMobileTab] = useState<"chat" | "model">("chat");
  const [modelTabBadge, setModelTabBadge] = useState(false);

  const [showCodeModal, setShowCodeModal] = useState(false);
  const [showNewChatConfirm, setShowNewChatConfirm] = useState(false);
  const [chatWidth, setChatWidth] = useState(400);
  const [isDesktop, setIsDesktop] = useState(true);

  const isResizingRef = useRef(false);
  const resizeRafRef = useRef<number | null>(null);

  // The design session owns the current design + working copy + preview render;
  // the panes read it from context. Inner only needs displayedStl (mobile badge)
  // and reset (New Chat).
  const session = useProvideDesignSession({ messages, isRunning, workingCodeRef, onError: toast });
  const { displayedStl } = session;
  // Persisted model ids can predate a dropdown change; fall back to the
  // default instead of displaying a raw unknown id in the header.
  const setModelSafe = useCallback(
    (m: string) => setModel(ALLOWED_MODEL_IDS.includes(m) ? m : MODELS[0].id),
    [setModel],
  );
  const { clearPersisted } = useChatPersistence({
    runtime,
    messages,
    isRunning,
    model,
    setModel: setModelSafe,
    onPersistError: toast,
  });

  // Resize handler for the divider. RAF-coalesces state updates to one per frame.
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(280, Math.min(900, e.clientX));
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(() => {
        resizeRafRef.current = null;
        setChatWidth(newWidth);
      });
    };
    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
    };
  }, []);

  const startResize = () => {
    isResizingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // Track viewport size so the resize divider (desktop-only) is disabled on
  // small screens where the layout stacks vertically.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Dot on the mobile Model tab when a render lands while Chat is active.
  // Signals the payoff without yanking the user out of the conversation.
  // Gated to mobile: on desktop both panels are visible, so there is no tab to
  // badge and arming it would leave a stale dot if the viewport later narrows.
  const prevStlRef = useRef(displayedStl);
  useEffect(() => {
    if (displayedStl && displayedStl !== prevStlRef.current && mobileTab === "chat" && !isDesktop) {
      setModelTabBadge(true);
    }
    prevStlRef.current = displayedStl;
  }, [displayedStl, mobileTab, isDesktop]);

  const showModelTab = useCallback(() => {
    setMobileTab("model");
    setModelTabBadge(false);
  }, []);

  // Messages sent while a turn runs (message-queue.ts). In memory only.
  const [queue] = useState(createMessageQueueController);
  const queueState = useSyncExternalStore(queue.subscribe, queue.getState, queue.getState);

  const handleStop = () => {
    // Recorded before cancelling so the turn's end pauses the queue.
    queue.dispatch({ type: "stop" });
    threadRuntime.cancelRun();
  };

  // Resend the last user message after a failed turn. startRun with that
  // message as parent goes through the AI SDK runtime's reload path: the
  // thread is sliced back to it (dropping the failed reply) and regenerated.
  const handleRetry = useCallback(() => {
    const parentId = findRetryTarget(messages, isRunning);
    if (parentId) threadRuntime.startRun({ parentId });
  }, [messages, isRunning, threadRuntime]);

  const performNewChatReset = () => {
    void resetConversation(threadRuntime, {
      isRunning: threadRuntime.getState().isRunning,
      clearQueue: () => queue.dispatch({ type: "clear" }),
      resetLocalState: () => {
        session.reset();
        setPrompt("");
        setPendingImage(null);
        setMobileTab("chat");
        setModelTabBadge(false);
        setModel(MODELS[0].id);
      },
      clearPersisted,
    });
  };

  // Instant reset when there's nothing to lose; otherwise confirm first
  // (UX audit #15) since a stray click used to wipe an in-progress design.
  const handleNewChat = () => {
    if (messages.length > 0) setShowNewChatConfirm(true);
    else performNewChatReset();
  };

  const confirmNewChat = () => {
    setShowNewChatConfirm(false);
    performNewChatReset();
  };

  const appendUserMessage = useCallback(
    (text: string, image: string | null) => {
      type UserContent = Parameters<typeof threadRuntime.append>[0] extends string
        ? never
        : Extract<Parameters<typeof threadRuntime.append>[0], { content: unknown }>["content"];
      const content: UserContent = image
        ? [{ type: "text", text }, { type: "image", image }]
        : [{ type: "text", text }];
      threadRuntime.append({ role: "user", content });
    },
    [threadRuntime],
  );

  // A queued item goes through the same append as a typed message, so the
  // transport applies the basis, image stripping, model and web search at
  // send time rather than when it was queued.
  const sendQueued = useCallback(
    (item: QueuedMessage) => appendUserMessage(outgoingText(item.text, item.image), item.image),
    [appendUserMessage],
  );

  // Drive the queue from the turn's edges. A normal finish sends the next
  // item; an error or Stop pauses. The controller holds the state outside
  // React, so a re-run of this effect cannot send an item twice.
  const prevRunningRef = useRef(isRunning);
  useEffect(() => {
    if (prevRunningRef.current === isRunning) return;
    prevRunningRef.current = isRunning;
    if (isRunning) {
      queue.dispatch({ type: "runStarted" });
      return;
    }
    const { send } = queue.dispatch({ type: "runEnded", failed: turnFailed(messages) });
    if (send) sendQueued(send);
  }, [isRunning, messages, queue, sendQueued]);

  const tooLongMessage = `Prompt exceeds maximum length of ${APP_CONSTANTS.MAX_PROMPT_LENGTH.toLocaleString()} characters.`;

  // Local re-renders (isRendering) don't lock the composer, only an active
  // AI turn does (UX audit #6), and during a turn sending queues instead.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (isRunning) {
      const { rejected } = queue.dispatch({
        type: "enqueue",
        text: prompt,
        image: pendingImage,
        maxLength: APP_CONSTANTS.MAX_PROMPT_LENGTH,
      });
      if (rejected === "too-long") toast(tooLongMessage);
      if (rejected === "full") {
        toast(`The queue is full (${MAX_QUEUED_MESSAGES} messages). Remove one or wait for the reply.`);
      }
      if (rejected) return;
    } else {
      const invalid = validateOutgoing(prompt, pendingImage, APP_CONSTANTS.MAX_PROMPT_LENGTH);
      if (invalid === "too-long") toast(tooLongMessage);
      if (invalid) return;
      appendUserMessage(outgoingText(prompt, pendingImage), pendingImage);
    }

    setPrompt("");
    setPendingImage(null);
  };

  // Edit moves a queued message back into the composer. Refused while a draft
  // is in progress, so neither the draft nor the queued message is lost.
  const handleEditQueued = (id: number): boolean => {
    if (prompt.trim() || pendingImage) {
      toast("Send or clear the message you are writing before editing a queued one.");
      return false;
    }
    const { taken } = queue.dispatch({ type: "take", id });
    if (!taken) return false;
    setPrompt(taken.text);
    setPendingImage(taken.image);
    return true;
  };

  const handleRemoveQueued = (id: number) => {
    queue.dispatch({ type: "remove", id });
  };

  const handleResumeQueue = () => {
    const { send } = queue.dispatch({ type: "resume", isRunning });
    if (send) sendQueued(send);
  };

  // One-click starter from the empty-state example chips: send immediately so
  // a first-time user sees a result without composing anything.
  const handleExample = useCallback(
    (text: string) => {
      if (isRunning) return;
      appendUserMessage(text, null);
    },
    [isRunning, appendUserMessage],
  );

  return (
    <DesignSessionProvider value={session}>
    <div className="flex flex-col h-screen max-h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden text-gray-800 dark:text-gray-100">
      <Header
        model={model}
        setModel={setModel}
        webSearch={webSearch}
        setWebSearch={setWebSearch}
        webSearchAvailable={webSearchAvailable}
      />

      {/* Mobile tab switch (UX audit #14): Chat and Model each get the full
          height below the header instead of a cramped 55vh split. */}
      <div
        role="tablist"
        aria-label="Panel"
        className="flex md:hidden bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 shrink-0"
      >
        <button
          role="tab"
          aria-selected={mobileTab === "chat"}
          onClick={() => setMobileTab("chat")}
          className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            mobileTab === "chat"
              ? "border-primary-600 text-primary-700 dark:text-primary-300"
              : "border-transparent text-gray-500 dark:text-gray-400"
          }`}
        >
          Chat
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === "model"}
          onClick={showModelTab}
          className={`flex-1 py-2.5 text-sm font-medium border-b-2 transition-colors relative ${
            mobileTab === "model"
              ? "border-primary-600 text-primary-700 dark:text-primary-300"
              : "border-transparent text-gray-500 dark:text-gray-400"
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            Model
            {modelTabBadge && (
              <span className="w-2 h-2 rounded-full bg-primary-500" aria-label="New render available" />
            )}
          </span>
        </button>
      </div>

      {/* Main */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Chat panel */}
        <div
          style={isDesktop ? { width: chatWidth } : undefined}
          className={`${mobileTab === "chat" ? "flex" : "hidden"} md:flex flex-1 md:flex-none min-h-0 w-full shrink-0 bg-white dark:bg-gray-900 md:border-r border-gray-200 dark:border-gray-800 flex-col z-0`}
        >
          {messages.length > 0 && (
            <div className="px-4 pt-3 pb-0 shrink-0 flex justify-end">
              <button
                onClick={handleNewChat}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                New Chat
              </button>
            </div>
          )}

          <MessageList
            messages={messages}
            isRunning={isRunning}
            onExample={handleExample}
            onRetry={handleRetry}
            onOpenCodeModal={() => setShowCodeModal(true)}
          />

          <Composer
            prompt={prompt}
            setPrompt={setPrompt}
            pendingImage={pendingImage}
            setPendingImage={setPendingImage}
            isRunning={isRunning}
            onSubmit={handleSubmit}
            onStop={handleStop}
            queue={queueState}
            onEditQueued={handleEditQueued}
            onRemoveQueued={handleRemoveQueued}
            onResumeQueue={handleResumeQueue}
          />
        </div>

        {/* Divider */}
        <div
          onMouseDown={startResize}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 20;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setChatWidth((w) => Math.max(280, w - step));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setChatWidth((w) => Math.min(900, w + step));
            } else if (e.key === "Home") {
              e.preventDefault();
              setChatWidth(280);
            } else if (e.key === "End") {
              e.preventDefault();
              setChatWidth(900);
            }
          }}
          tabIndex={0}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          aria-valuenow={chatWidth}
          aria-valuemin={280}
          aria-valuemax={900}
          className="hidden md:block w-1 shrink-0 bg-gray-200 dark:bg-gray-700 hover:bg-primary-400 active:bg-primary-500 focus-visible:bg-primary-500 focus-visible:outline-none cursor-col-resize transition-colors"
        />

        <ViewerPane
          mobileTab={mobileTab}
          isRunning={isRunning}
          setPendingImage={setPendingImage}
        />
      </main>

      <CodeEditorModal
        open={showCodeModal}
        onClose={() => setShowCodeModal(false)}
        isRunning={isRunning}
      />

      <NewChatConfirmDialog
        open={showNewChatConfirm}
        onClose={() => setShowNewChatConfirm(false)}
        onConfirm={confirmNewChat}
      />
    </div>
    </DesignSessionProvider>
  );
}

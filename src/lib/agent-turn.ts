import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
  convertToModelMessages,
  safeValidateUIMessages,
  stepCountIs,
  streamText,
  type InferUITools,
  type ModelMessage,
  type StepResult,
  type TextStreamPart,
  type UIDataTypes,
  type UIMessage,
} from "ai";
import { MAX_AGENT_STEPS } from "@/components/chat/constants";
import { createRunCadqueryTool, systemPromptForTurn, type RenderReport } from "./cad-agent";
import { callCadWorker, pingCadWorker } from "./cad-worker";
import type { RenderWorker } from "./cad-render";
import { webSearchProviderOptions } from "./web-search";
import { modelSupportsTemperature } from "./utils";
import { stepUsage, sumReported } from "./usage";

// One CAD agent turn: a conversation goes in, the model runs up to
// MAX_AGENT_STEPS steps calling runCadquery (each call renders on the CAD
// worker), and the turn ends with a text reply. This module is the only place
// a turn is built. The production route streams it to the client; the eval
// runner and the fixture replay consume the same stream to completion.
//
// It owns the system prompt, step cap, final text-only step, per-model provider
// options, output cap, retries, the turn timeout, the worker liveness check and
// the abort wiring down to the worker fetch. Callers supply the adapters (model,
// worker) and a single onSettled callback.

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter model adapter, shared by the production route and the eval
 * runner. Builds exactly `modelId`: the route applies the model allowlist
 * first (allowedModelId), while evals may run candidate models that are not on
 * it yet.
 */
export function openRouterModel(modelId: string, apiKey: string | undefined): LanguageModelV3 {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  // includeUsage: a streamed response only reports token usage (and
  // OpenRouter's cost) when asked for it; the eval cost cap depends on it.
  return createOpenAICompatible({ name: "openrouter", apiKey, baseURL: OPENROUTER_BASE_URL, includeUsage: true })(
    modelId,
  );
}

/** The CAD worker as the turn uses it. */
export interface AgentWorker {
  /** Render one script. Receives the turn's abort signal. */
  render: RenderWorker;
  /** Liveness probe, checked before the paid model call. Should not throw. */
  ping: () => Promise<boolean>;
}

export const liveCadWorker: AgentWorker = {
  render: callCadWorker,
  ping: () => pingCadWorker(),
};

// Sent only to models that accept it (modelSupportsTemperature): OpenRouter
// silently drops it for the others.
const TEMPERATURE = 0.2;
// Caps the model's reply per turn. Prevents a single verbose generation (or a
// prompt-injection that asks for "explain every line") from burning 30k+
// output tokens at unbounded cost. 16k because a truncated tool call is dropped
// whole: complex parts plus reasoning tokens overflow 8k (measured on
// claude-sonnet-5 AND deepseek-v4-flash), and the turn timeout already bounds
// runaway cost.
const MAX_OUTPUT_TOKENS = 16_000;

/** Wall-clock budget for a whole turn, composed with the caller's abort signal. */
export const AGENT_TURN_TIMEOUT_MS = 120_000;

/**
 * Per-step overrides (stepNumber is 0-based).
 * - Last allowed step: tools off. With stopWhen: stepCountIs(MAX_AGENT_STEPS)
 *   the loop can otherwise end on a tool call, leaving the user with a render
 *   (or a failure) and no explanation.
 * - First step: web search, when the turn has it. Specs are looked up before
 *   the first script; later steps fix renders and don't pay for a new search.
 *   Merged over the per-model options by the SDK.
 */
function agentStepPreparer(webSearchOptions: ProviderOptions | undefined) {
  return ({ stepNumber }: { stepNumber: number }): { toolChoice?: "none"; providerOptions?: ProviderOptions } => {
    if (stepNumber >= MAX_AGENT_STEPS - 1) return { toolChoice: "none" };
    if (stepNumber === 0 && webSearchOptions) return { providerOptions: webSearchOptions };
    return {};
  };
}

/**
 * Claude models reason by default via OpenRouter; unbounded, the thinking can
 * consume the entire output budget and the turn ends with finish_reason
 * "length" and NO tool call (measured on claude-sonnet-5: 3/8 eval cases
 * emitted nothing). Capping the reasoning budget keeps the final answer inside
 * the output cap. OpenRouter normalizes `reasoning` across providers; other
 * models are left untouched.
 */
function providerOptionsForModel(modelId: string): ProviderOptions | undefined {
  if (modelId.startsWith("anthropic/")) {
    return { openrouter: { reasoning: { max_tokens: 2048 } } };
  }
  return undefined;
}

type AgentTools = { runCadquery: ReturnType<typeof createRunCadqueryTool> };

/** A chat message whose tool parts are typed by the turn's tools. */
export type AgentUIMessage = UIMessage<unknown, UIDataTypes, InferUITools<AgentTools>>;

// Validation and history conversion only read the tool's schemas and
// toModelOutput; this instance is never executed.
const VALIDATION_TOOLS: AgentTools = {
  runCadquery: createRunCadqueryTool({
    requestId: "validation",
    worker: () => Promise.reject(new Error("validation tools are not executable")),
  }),
};

/** Validate inbound chat history, including runCadquery parts against the tool's input schema. */
export function validateAgentUIMessages(messages: unknown[]) {
  return safeValidateUIMessages<AgentUIMessage>({ messages, tools: VALIDATION_TOOLS });
}

/**
 * Convert validated chat history to model messages. Prior runCadquery results
 * go through the tool's toModelOutput, the same projection as within a turn,
 * so the STL never reaches the model even when the client failed to strip it.
 * A turn stopped mid tool call leaves tool parts with no result; providers
 * reject a tool call without its result, so those are dropped.
 */
export function toAgentModelMessages(messages: AgentUIMessage[]): Promise<ModelMessage[]> {
  return convertToModelMessages(messages, { tools: VALIDATION_TOOLS, ignoreIncompleteToolCalls: true });
}

/** Shown when the turn's last step produced neither text nor a tool call. */
export const EMPTY_REPLY_TEXT = {
  /** An earlier step of the turn rendered: the design is there, only the description is missing. */
  rendered: "Design updated. The model ended the turn without describing the changes.",
  length:
    "The model ran out of output tokens before producing a design or a reply. Try again, ask for a simpler part, or switch models.",
  "content-filter": "The model provider's content filter blocked the reply. Try rephrasing the request or switch models.",
  other: "The model ended the turn without producing a design or a reply. Try again or switch models.",
} as const;

const EMPTY_REPLY_TEXTS: ReadonlySet<string> = new Set(Object.values(EMPTY_REPLY_TEXT));

/** Whether a turn's final text is the fallback added to an empty final step, not the model's own reply. */
export function isEmptyReplyFallback(text: string): boolean {
  return EMPTY_REPLY_TEXTS.has(text);
}

function emptyReplyText(finishReason: string, rendered: boolean): string {
  if (rendered) return EMPTY_REPLY_TEXT.rendered;
  if (finishReason === "length") return EMPTY_REPLY_TEXT.length;
  if (finishReason === "content-filter") return EMPTY_REPLY_TEXT["content-filter"];
  return EMPTY_REPLY_TEXT.other;
}

// A step that ends with neither text nor a tool call is always the last one
// (the loop only continues after tool calls), and the user would get an empty
// reply: e.g. finishReason "length" after the output cap went to reasoning, or
// a malformed tool call the provider dropped. Adds a fallback text to that step
// so the chat shows why, the model sees it as its reply next turn, and the
// turn's own results (steps, onFinish) include it. The text depends on whether
// an earlier step of the turn rendered. A step that ended in "error" gets
// none: the error part already reaches the client.
function fillEmptyFinalStep(
  chunk: TextStreamPart<AgentTools>,
  controller: TransformStreamDefaultController<TextStreamPart<AgentTools>>,
  state: { hasOutput: boolean; rendered: boolean },
) {
  if (chunk.type === "start-step") state.hasOutput = false;
  if ((chunk.type === "text-delta" && chunk.text.trim()) || chunk.type === "tool-call") state.hasOutput = true;
  if (chunk.type === "tool-result" && (chunk.output as { success?: unknown } | undefined)?.success === true) {
    state.rendered = true;
  }
  if (chunk.type === "finish-step" && !state.hasOutput && chunk.finishReason !== "error") {
    const id = "empty-reply-fallback";
    controller.enqueue({ type: "text-start", id });
    controller.enqueue({ type: "text-delta", id, text: emptyReplyText(chunk.finishReason, state.rendered) });
    controller.enqueue({ type: "text-end", id });
  }
  controller.enqueue(chunk);
}

/** Logs a turn's token usage and OpenRouter's reported cost, summed over its completed steps. */
function logTurnUsage(requestId: string, modelId: string, outcome: string, steps: StepResult<AgentTools>[]) {
  const usages = steps.map((step) => stepUsage(step.usage));
  const cost = sumReported(usages, "costUsd");
  console.info(
    `[${requestId}] agent turn ${outcome}: model=${modelId} steps=${steps.length}` +
      ` tokens=${sumReported(usages, "inputTokens") ?? "?"}/${sumReported(usages, "outputTokens") ?? "?"}` +
      ` cost=${cost === null ? "?" : `$${cost.toFixed(4)}`}`,
  );
}

interface AgentTurnOptions {
  /** Model adapter: openRouterModel in production and live evals, a mock in tests and replay. */
  model: LanguageModelV3;
  /** The conversation so far (model messages), or a single user prompt. */
  prompt: string | ModelMessage[];
  worker: AgentWorker;
  requestId: string;
  /** Caller's abort (client disconnect). Composed with the turn timeout. */
  abortSignal?: AbortSignal;
  onRender?: (render: RenderReport) => void;
  /**
   * Fires exactly once when the turn is over: finished, aborted (caller or
   * timeout), failed, refused because the worker is down, or thrown
   * synchronously. The route passes its generation-lease release here.
   */
  onSettled?: () => void;
  /**
   * Let the model search the web on the first step (engine per model in
   * MODELS, see web-search.ts). Default off; the route turns it on when both
   * the server switch and the user's toggle allow it.
   */
  webSearch?: boolean;
}

function startStream(o: {
  model: LanguageModelV3;
  prompt: string | ModelMessage[];
  tools: AgentTools;
  abortSignal: AbortSignal;
  requestId: string;
  webSearch: boolean;
  end: () => void;
}) {
  // Search is on for this turn only when requested AND enabled for the model.
  const webSearchOptions = o.webSearch ? webSearchProviderOptions(o.model.modelId) : undefined;
  return streamText({
    model: o.model,
    system: systemPromptForTurn(webSearchOptions !== undefined),
    prompt: o.prompt,
    temperature: modelSupportsTemperature(o.model.modelId) ? TEMPERATURE : undefined,
    providerOptions: providerOptionsForModel(o.model.modelId),
    maxRetries: 0,
    tools: o.tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    // Tools off on the last allowed step, so the turn ends with text; web
    // search (when on) on the first step only.
    prepareStep: agentStepPreparer(webSearchOptions),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: o.abortSignal,
    // The turn ends when the step loop's stream terminates:
    // - flush: it closed, after the final step, after an abort, or after a
    //   fatal error with no step recorded (neither onFinish nor onAbort fires).
    // - cancel: it errored, e.g. the provider connection dropped mid-stream.
    //   No SDK callback fires on that path, so it is logged here, once.
    // An error part alone does NOT end the turn: the provider can keep
    // streaming and the SDK keeps running tools and steps after it, so it is
    // only logged (onError). The turn timeout remains the backstop for a
    // stream that never terminates.
    // It also adds the fallback reply to an empty final step (fillEmptyFinalStep).
    experimental_transform: () => {
      const state = { hasOutput: false, rendered: false };
      // `cancel` is part of the Streams standard and implemented by Node, but
      // TypeScript's DOM lib does not declare it on Transformer yet.
      const transformer: Transformer<TextStreamPart<AgentTools>, TextStreamPart<AgentTools>> & {
        cancel: (reason: unknown) => void;
      } = {
        transform: (chunk, controller) => fillEmptyFinalStep(chunk, controller, state),
        flush: () => o.end(),
        cancel: (reason) => {
          console.error(`[${o.requestId}] agent turn stream failed:`, reason);
          o.end();
        },
      };
      return new TransformStream(transformer);
    },
    onError: ({ error }) => {
      console.error(`[${o.requestId}] agent turn error:`, error);
    },
    // Usage is logged however the turn ends with completed steps: finished, or
    // aborted (caller or turn timeout), which a timed-out turn still paid for.
    onFinish: ({ steps, finishReason }) => {
      logTurnUsage(o.requestId, o.model.modelId, `finished (${finishReason})`, steps);
    },
    onAbort: ({ steps }) => {
      logTurnUsage(o.requestId, o.model.modelId, "aborted", steps);
    },
  });
}

type AgentTurn =
  | { ok: true; stream: ReturnType<typeof startStream> }
  | { ok: false; reason: "worker-unavailable" };

/**
 * Run one agent turn. Resolves to the live stream, or to a refusal when the
 * CAD worker is down (checked before any model call, so an outage costs no
 * tokens). The stream is lazy: the caller must consume it (return it as a
 * response, or drain it) for the turn to progress.
 */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentTurn> {
  const { model, prompt, worker, requestId, abortSignal, onRender, onSettled, webSearch = false } = options;

  // `end` is called only when the turn is truly over (stream closed, signal
  // aborted, timer fired, refusal, synchronous failure). Until then the turn
  // timeout and the abort listener stay armed.
  let ended = false;
  let disarm = () => {};
  const end = () => {
    if (ended) return;
    ended = true;
    disarm();
    onSettled?.();
  };

  try {
    // Fail fast if the CAD worker is down. Otherwise the model calls
    // runCadquery, gets a connection error, and retries up to MAX_AGENT_STEPS
    // times, burning ~5x the tokens for zero usable output. A sub-second
    // liveness probe is far cheaper.
    if (!(await worker.ping())) {
      end();
      return { ok: false, reason: "worker-unavailable" };
    }

    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      AGENT_TURN_TIMEOUT_MS,
    );
    timer.unref?.();
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeout.signal]) : timeout.signal;
    // An abort ends the turn even if nobody reads the stream any more (client
    // gone): the model request and the in-flight worker call are cancelled
    // with it, so the turn ends as soon as the signal fires.
    signal.addEventListener("abort", end, { once: true });
    disarm = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
    };
    if (signal.aborted) end();

    const tools: AgentTools = { runCadquery: createRunCadqueryTool({ requestId, worker: worker.render, onRender }) };
    const stream = startStream({ model, prompt, tools, abortSignal: signal, requestId, webSearch, end });
    return { ok: true, stream };
  } catch (e) {
    end();
    throw e;
  }
}

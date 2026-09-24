import { NextResponse } from "next/server";
import { createUIMessageStreamResponse, type ModelMessage, type UIMessageChunk } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { z } from "zod";
import { APP_CONSTANTS } from "@/lib/utils";
import { OMITTED_SNAPSHOT_TEXT } from "@/lib/constants";
import { withRoute } from "@/lib/api-handler";
import { sanitizeError, toSanitizedMessage } from "@/lib/sanitize-error";
import { withGenerationLease } from "@/lib/in-flight";
import { dataUrlMediaType } from "@/components/chat/strip-images";
import {
  AGENT_TURN_TIMEOUT_MS,
  runAgentTurn,
  toAgentModelMessages,
  validateAgentUIMessages,
  type AgentUIMessage,
  type AgentWorker,
} from "@/lib/agent-turn";

// The /api/generate-cad handler: HTTP concerns only (request validation, the
// generation lease, the response). The agent turn itself is runAgentTurn. The
// adapters are injected so tests can drive the real handler with a mock model
// and a fake worker; route.ts wires the production ones.

// Whole-body ceiling, enforced while the body streams in (api-handler.ts).
// The client sends one viewport snapshot per turn (JPEG, <= 1024px long edge)
// and strips images from older turns, so a normal request is far below this;
// the rest of the budget is conversation text and prior scripts.
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
// Per-image ceiling, in decoded bytes, for the image the user is sending now.
// A 1024px JPEG snapshot is a few hundred KB; this leaves room for a PNG from
// an older client. Images in older turns are never rejected (see
// applyHistoryImagePolicy).
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// Hard cap on inbound history. The model's context window is the real
// constraint; this is a defense-in-depth bound to reject malicious payloads.
const MAX_HISTORY_MESSAGES = 200;
// Ceiling on the model-bound conversation, in characters (text, tool calls and
// tool results after the STL is stripped; the one image left is capped by
// MAX_IMAGE_BYTES instead). The body cap alone would let ~10 MB of text through
// to a paid model call. 300k characters is ~75k tokens: dozens of turns with
// full scripts, well under every allowed model's context window. Old render
// attempts are trimmed to fit first (fitToInputCap).
export const MAX_MODEL_INPUT_CHARS = 300_000;

// First pass: shape and role only. The full UIMessage structure is checked by
// the AI SDK's validator in the handler. Only user and assistant turns are
// accepted: a client-supplied "system" message would otherwise become a real
// system prompt next to SYSTEM_PROMPT.
const RequestSchema = z.object({
  messages: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant"], { error: "Only user and assistant messages are accepted." }),
      }),
    )
    .min(1)
    .max(MAX_HISTORY_MESSAGES),
  model: z.string().optional(),
  // The user's web search toggle. Omitted means on (the toggle's default);
  // search still needs the server switch (GenerateCadDeps.webSearchAvailable).
  webSearch: z.boolean().optional(),
});

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

// Decoded size of a base64 data URL payload, without decoding it.
function base64DecodedBytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

type CadPart = AgentUIMessage["parts"][number];

// Why a file part can't go to the model, or null when it can. Inline images
// only: a remote URL would make the server (or the model provider) fetch an
// arbitrary address on the caller's behalf. The mediaType field isn't trusted
// (assistant-ui labels every image image/png), so the data URL's own prefix is
// what's checked.
function fileProblem(p: Extract<CadPart, { type: "file" }>): string | null {
  const match = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(p.url);
  if (!match) return "Only inline image attachments are supported.";
  if (base64DecodedBytes(p.url.slice(match[0].length)) > MAX_IMAGE_BYTES) {
    return `Image attachment too large (max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB).`;
  }
  return null;
}

function newestUserIndex(messages: AgentUIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
  return -1;
}

// The server's image policy, in one pass. Only the newest user message keeps
// its images: older user turns lose every file part (the client's own policy,
// stripOlderImages, enforced here too so an older or modified client can't send
// every snapshot of a long chat to the model), and assistant turns lose the
// file parts that can't go to the model. Dropped parts leave one
// OMITTED_SNAPSHOT_TEXT per message. Nothing in older turns is rejected: saved
// chats can hold full-resolution PNGs from before the client shrank them, and a
// 400 there would break every later turn of the chat. The newest user message
// is the caller's current input and is checked strictly in checkContentLimits.
function applyHistoryImagePolicy(messages: AgentUIMessage[]): AgentUIMessage[] {
  const newest = newestUserIndex(messages);
  return messages.map((m, i) => {
    if (i === newest) {
      // assistant-ui labels every image image/png; snapshots are JPEG, so the
      // model is told the data URL's own type.
      if (!m.parts.some((p) => p.type === "file")) return m;
      const parts = m.parts.map((p) => {
        if (p.type !== "file") return p;
        const actual = dataUrlMediaType(p.url);
        return actual && actual !== p.mediaType ? { ...p, mediaType: actual } : p;
      });
      return { ...m, parts };
    }
    const drop = (p: CadPart) => p.type === "file" && (m.role === "user" || fileProblem(p) !== null);
    if (!m.parts.some(drop)) return m;
    const parts = m.parts.filter((p) => !drop(p));
    if (!parts.some((p) => p.type === "text" && p.text === OMITTED_SNAPSHOT_TEXT)) {
      parts.push({ type: "text", text: OMITTED_SNAPSHOT_TEXT });
    }
    return { ...m, parts };
  });
}

// Characters one model message sends to the model, images excluded.
function messageChars(m: ModelMessage): number {
  if (typeof m.content === "string") return m.content.length;
  let n = 0;
  for (const p of m.content) n += p.type === "file" || p.type === "image" ? 0 : JSON.stringify(p).length;
  return n;
}

/** Stands in for the code and result of an old runCadquery call trimmed to fit MAX_MODEL_INPUT_CHARS. */
export const OMITTED_ATTEMPT_TEXT = "[earlier attempt omitted]";
// Turns (a user message and the replies after it) never trimmed, counted from
// the newest.
const KEEP_RECENT_TURNS = 2;

// The newest successful runCadquery result: the basis the model edits (with
// the user's hand edits, if any), so it is never trimmed.
function basisToolCallId(messages: ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j];
      if (p.type !== "tool-result" || p.output.type !== "json") continue;
      if ((p.output.value as { success?: unknown } | null)?.success === true) return p.toolCallId;
    }
  }
  return undefined;
}

// Without this, a long design chat (a full script per render attempt) would
// reach MAX_MODEL_INPUT_CHARS and 413 on every later request. Replaces the code
// and result of the oldest runCadquery calls with OMITTED_ATTEMPT_TEXT, one
// message at a time, until the conversation fits. Never trimmed: the last
// KEEP_RECENT_TURNS turns, the basis call and its result, and all text. Returns
// the messages (trimmed or not) and their size, which can still be over the cap.
function fitToInputCap(messages: ModelMessage[]): { messages: ModelMessage[]; chars: number } {
  const sizes = messages.map(messageChars);
  let chars = sizes.reduce((a, b) => a + b, 0);
  if (chars <= MAX_MODEL_INPUT_CHARS) return { messages, chars };

  let recentStart = messages.length;
  for (let turns = 0; recentStart > 0 && turns < KEEP_RECENT_TURNS; ) {
    recentStart--;
    if (messages[recentStart].role === "user") turns++;
  }
  const basis = basisToolCallId(messages);
  const trimmed = [...messages];
  for (let i = 0; i < recentStart && chars > MAX_MODEL_INPUT_CHARS; i++) {
    const m = trimmed[i];
    if (m.role === "assistant" && typeof m.content !== "string") {
      const content = m.content.map((p) =>
        p.type === "tool-call" && p.toolCallId !== basis ? { ...p, input: { code: OMITTED_ATTEMPT_TEXT } } : p,
      );
      trimmed[i] = { ...m, content };
    } else if (m.role === "tool") {
      const content = m.content.map((p) =>
        p.type === "tool-result" && p.toolCallId !== basis
          ? { ...p, output: { type: "text" as const, value: OMITTED_ATTEMPT_TEXT } }
          : p,
      );
      trimmed[i] = { ...m, content };
    } else {
      continue;
    }
    const size = messageChars(trimmed[i]);
    chars += size - sizes[i];
    sizes[i] = size;
  }
  return { messages: trimmed, chars };
}

// Content rules the SDK validator doesn't know about. Returns an error message,
// or null when the history is acceptable.
function checkContentLimits(messages: AgentUIMessage[]): string | null {
  const newest = newestUserIndex(messages);
  for (const [i, m] of messages.entries()) {
    if (m.role !== "user") continue;
    // The omitted-snapshot placeholder isn't the user's prompt; counting it
    // would reject a near-limit prompt on every later turn.
    const textLength = m.parts.reduce(
      (n, p) => n + (p.type === "text" && p.text !== OMITTED_SNAPSHOT_TEXT ? p.text.length : 0),
      0,
    );
    if (textLength > APP_CONSTANTS.MAX_PROMPT_LENGTH) {
      return `Prompt exceeds maximum length of ${APP_CONSTANTS.MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`;
    }
    if (i !== newest) continue;
    for (const p of m.parts) {
      const problem = p.type === "file" ? fileProblem(p) : null;
      if (problem) return problem;
    }
  }
  return null;
}

// The UI stream reports an aborted turn with an "abort" chunk, which the chat
// client treats as a clean finish. The only abort a listening client can see
// is the server's own turn timeout (a client that stopped has stopped reading),
// so it is sent as an error instead: the thread shows it with Retry, and a
// queued follow-up is not sent on top of a turn that never finished.
function abortAsError(): TransformStream<UIMessageChunk, UIMessageChunk> {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type !== "abort") {
        controller.enqueue(chunk);
        return;
      }
      controller.enqueue({ type: "error", errorText: sanitizeError(chunk.reason ?? "The agent turn was aborted.") });
    },
  });
}

export interface GenerateCadDeps {
  /** Model adapter for the requested model id (the route applies the allowlist). */
  model: (requestedModelId: string | undefined) => LanguageModelV3;
  worker: AgentWorker;
  /** Server switch for web search (WEB_SEARCH in production). Absent means off. */
  webSearchAvailable?: () => boolean;
}

export function createGenerateCadPost(deps: GenerateCadDeps) {
  return withRoute(
    {
      rateKey: "generate",
      rateLimit: 10,
      schema: RequestSchema,
      bodyCap: MAX_REQUEST_BYTES,
      killSwitchEnv: "EMERGENCY_DISABLE_GENERATION",
    },
    async ({ messages: rawMessages, model, webSearch }, { requestId, signal }) => {
      // A turn stopped before anything streamed can be persisted with no parts.
      // It carries nothing for the model, so drop it instead of rejecting a
      // saved chat over it.
      const nonEmpty = rawMessages.filter((m) => !Array.isArray(m.parts) || m.parts.length > 0);
      const validated = await validateAgentUIMessages(nonEmpty);
      if (!validated.success) {
        console.warn(`[${requestId}] rejected message history: ${validated.error.message.slice(0, 500)}`);
        return bad("Invalid message format.");
      }
      const uiMessages = applyHistoryImagePolicy(validated.data);
      const limitError = checkContentLimits(uiMessages);
      if (limitError) return bad(limitError);

      // Converted before the lease is taken: this is still request validation
      // (a failure is the client's 400), so it must not hold a slot.
      let modelMessages: ModelMessage[];
      try {
        // Strips the STL from prior tool results and drops incomplete tool
        // calls (see toAgentModelMessages). Data parts are ignored.
        modelMessages = await toAgentModelMessages(uiMessages);
      } catch (e: unknown) {
        // Preserve the 400 contract: malformed UIMessages are a client error,
        // not a server fault that withRoute's catch-all should turn into a 500.
        // Same stable text as the validator path; the detail goes to the log.
        console.warn(`[${requestId}] message conversion failed: ${e instanceof Error ? e.message : String(e)}`);
        return bad("Invalid message format.");
      }
      const fitted = fitToInputCap(modelMessages);
      modelMessages = fitted.messages;
      const inputChars = fitted.chars;
      if (inputChars > MAX_MODEL_INPUT_CHARS) {
        console.warn(`[${requestId}] rejected oversized conversation: ${inputChars} model-bound characters`);
        return NextResponse.json(
          {
            error: `Conversation too large for the model (${inputChars.toLocaleString("en-US")} of max ${MAX_MODEL_INPUT_CHARS.toLocaleString("en-US")} characters). Start a new chat to continue.`,
          },
          { status: 413 },
        );
      }

      // Concurrency guard: a shared generation pool. The turn outlives this
      // function, so the lease's release is handed to the turn as onSettled,
      // which fires exactly once whichever way the turn ends. A throw before the
      // turn starts (e.g. no API key) is released by the lease itself.
      return withGenerationLease(
        async (release) => {
          const turn = await runAgentTurn({
            model: deps.model(model),
            prompt: modelMessages,
            worker: deps.worker,
            requestId,
            abortSignal: signal,
            onSettled: release,
            // Both switches must be on: the server's and the user's (omitted = on).
            webSearch: (deps.webSearchAvailable?.() ?? false) && webSearch !== false,
          });
          if (!turn.ok) {
            return NextResponse.json(
              { error: "The CAD engine is temporarily unavailable. Please try again in a moment." },
              { status: 503 },
            );
          }
          const stream = turn.stream
            .toUIMessageStream({
              // Already logged by the agent turn; this only shapes the client text.
              onError: (e) => {
                const prefix = e instanceof Error && e.name && e.name !== "Error" ? `${e.name}: ` : "";
                return prefix + toSanitizedMessage(e);
              },
            })
            .pipeThrough(abortAsError());
          return createUIMessageStreamResponse({ stream });
        },
        // Backstop a bit longer than the longest possible turn, in case a
        // terminal event is somehow never observed.
        AGENT_TURN_TIMEOUT_MS + 30_000,
      );
    },
  );
}

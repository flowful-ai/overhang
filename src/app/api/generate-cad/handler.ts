import { NextResponse } from "next/server";
import { convertToModelMessages, type ModelMessage } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { z } from "zod";
import { APP_CONSTANTS } from "@/lib/utils";
import { OMITTED_SNAPSHOT_TEXT } from "@/lib/constants";
import { withRoute } from "@/lib/api-handler";
import { toSanitizedMessage } from "@/lib/sanitize-error";
import { withGenerationLease } from "@/lib/in-flight";
import {
  AGENT_TURN_TIMEOUT_MS,
  runAgentTurn,
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
// dropUnusableHistoryImages).
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
// Hard cap on inbound history. The model's context window is the real
// constraint; this is a defense-in-depth bound to reject malicious payloads.
const MAX_HISTORY_MESSAGES = 200;

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

// Older turns: saved chats can hold full-resolution PNG snapshots from before
// the client shrank them. Rejecting those would 400 every later turn of the
// chat forever, so unusable file parts in older messages are dropped and
// replaced by one placeholder per message. The newest user message is the
// caller's current input and is checked strictly in checkContentLimits.
function dropUnusableHistoryImages(messages: AgentUIMessage[]): AgentUIMessage[] {
  const newest = newestUserIndex(messages);
  return messages.map((m, i) => {
    if (i === newest) return m;
    const bad = (p: CadPart) => p.type === "file" && fileProblem(p) !== null;
    if (!m.parts.some(bad)) return m;
    const parts = m.parts.filter((p) => !bad(p));
    if (!parts.some((p) => p.type === "text" && p.text === OMITTED_SNAPSHOT_TEXT)) {
      parts.push({ type: "text", text: OMITTED_SNAPSHOT_TEXT });
    }
    return { ...m, parts };
  });
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
      const uiMessages = dropUnusableHistoryImages(validated.data);
      const limitError = checkContentLimits(uiMessages);
      if (limitError) return bad(limitError);

      // Converted before the lease is taken: this is still request validation
      // (a failure is the client's 400), so it must not hold a slot.
      let modelMessages: ModelMessage[];
      try {
        // A turn stopped mid tool call leaves tool parts with no result
        // (input-streaming, or input-available with no output). Sent as-is,
        // providers reject a tool call without its result, so drop them. Data
        // parts are ignored by the converter.
        modelMessages = await convertToModelMessages(uiMessages, { ignoreIncompleteToolCalls: true });
      } catch (e: unknown) {
        // Preserve the 400 contract: malformed UIMessages are a client error,
        // not a server fault that withRoute's catch-all should turn into a 500.
        // Same stable text as the validator path; the detail goes to the log.
        console.warn(`[${requestId}] message conversion failed: ${e instanceof Error ? e.message : String(e)}`);
        return bad("Invalid message format.");
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
          return turn.stream.toUIMessageStreamResponse({
            // Already logged by the agent turn; this only shapes the client text.
            onError: (e) => {
              const prefix = e instanceof Error && e.name && e.name !== "Error" ? `${e.name}: ` : "";
              return prefix + toSanitizedMessage(e);
            },
          });
        },
        // Backstop a bit longer than the longest possible turn, in case a
        // terminal event is somehow never observed.
        AGENT_TURN_TIMEOUT_MS + 30_000,
      );
    },
  );
}

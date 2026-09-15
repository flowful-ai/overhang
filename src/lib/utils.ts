import { z } from "zod";

/**
 * Decode a base64 string to a Blob
 */
export function base64ToBlob(base64: string, mimeType: string = "application/octet-stream"): Blob {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Decode a base64 string and create an object URL
 * Remember to call URL.revokeObjectURL when done
 */
export function base64ToObjectUrl(base64: string, mimeType: string = "application/octet-stream"): string {
  const blob = base64ToBlob(base64, mimeType);
  return URL.createObjectURL(blob);
}

/**
 * Application constants
 */
export const APP_CONSTANTS = {
  MAX_PROMPT_LENGTH: 10000,
  MAX_CODE_LENGTH: 50_000,
  STL_MIME_TYPE: "application/sla",
} as const;

/**
 * Target printer build volume (Bambu default, mm, cubic). Single TS source:
 * interpolated into the system prompt (cad-agent.ts) and drawn as the
 * viewer's build plate (ThreeDViewer.tsx). The cad-worker's overflow warnings
 * read BUILD_VOLUME_MM in cad-worker/main.py — keep the two in sync.
 */
export const BUILD_VOLUME_MM = 256;

/**
 * Request body shared by the /api/render-cad and /api/export-3mf routes: a
 * single CadQuery code string bounded by MAX_CODE_LENGTH. Defined once so the
 * two routes can't drift on the validation.
 */
export const CodeBodySchema = z.object({
  code: z.string().min(1, "Missing code").max(APP_CONSTANTS.MAX_CODE_LENGTH),
});

// Curated from the 2026-07-02 eval sweep (docs/evals/2026-07-02-model-sweep.md):
// gemini-2.5-flash removed (0/8, malformed tool calls), deepseek-r1 removed
// (superseded by v4-flash; reasoning latency blows the 120s turn budget).
// GPT-5.6 Luna is the default; it was not part of that sweep.
//
// webSearch: whether the model gets OpenRouter web search (options built in
// src/lib/web-search.ts). Enabled only where a live turn (2026-09-15, prompt
// "Multiboard holder for a Brother P-touch PT-D210") confirmed a search AND
// the runCadquery call in the same step:
// - GPT-5.6 Luna, native: confirmed (1 search, then the tool call).
// - Claude Sonnet 5 (native) and DeepSeek V4 Flash (Parallel, no native
//   search): search plus a tool call was not confirmed; both turns hit the
//   120s timeout first. Search may not be the cause (their no-search eval
//   turns already take 80-93s, and no no-search run of that prompt was done).
// - Gemini 3 Flash, native: the tool call arrived but no search was reported.
export const MODELS = [
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna", webSearch: "native" },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", webSearch: false },
  { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash", webSearch: false },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", webSearch: false },
] as const;

export const ALLOWED_MODEL_IDS = MODELS.map(m => m.id) as string[];

/** Whether web search is enabled for this model id (see MODELS). Unlisted ids: no. */
export function modelSupportsWebSearch(modelId: string): boolean {
  return MODELS.find((m) => m.id === modelId)?.webSearch === "native";
}

/** The requested model when it is on the allowlist, otherwise the default (first) model. */
export function allowedModelId(requested: string | undefined): string {
  return requested && ALLOWED_MODEL_IDS.includes(requested) ? requested : ALLOWED_MODEL_IDS[0];
}

/** UUID v4 used to correlate frontend API requests with cad-worker logs. */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

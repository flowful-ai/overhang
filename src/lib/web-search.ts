import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { MODELS } from "./utils";

// Web search for the CAD agent. Enabled per model in MODELS (src/lib/utils.ts).
// Search runs only when the server allows it (WEB_SEARCH env) AND the request
// asks for it, and only on the first model step of a turn (agent-turn.ts), so
// fix-up steps never search. Within that step a native engine decides how many
// queries to run; each one is billed (usage.server_tool_use_details
// .web_search_requests, included in usage.cost). The plugin has no per-request
// cap on queries, only on results.
//
// Mechanism: OpenRouter's `web` plugin. OpenRouter now recommends the
// `openrouter:web_search` server tool instead (it adds a `max_uses` cap), but
// @ai-sdk/openai-compatible 2.0.75 cannot send it: provider-defined tools are
// dropped with an "unsupported" warning, and a `tools` key passed through
// providerOptions is overwritten by the function tools. Moving to it needs a
// provider package that forwards server tools, or a request-body transform.

/** Results requested per search. Enough for a datasheet and a product page. */
export const WEB_SEARCH_MAX_RESULTS = 3;

const ENABLING_VALUES = ["", "on", "1", "true"];
const DISABLING_VALUES = ["off", "0", "false"];

/**
 * Server switch, parsed strictly so a typo fails closed: unset, empty, "on",
 * "1" or "true" (any case) enable search; anything else disables it. Read per
 * call so the page and the route see the running container's env.
 */
export function webSearchEnabledOnServer(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.WEB_SEARCH?.trim().toLowerCase() ?? "";
  return ENABLING_VALUES.includes(value);
}

/** Boot-time warning for a WEB_SEARCH value that is neither on nor off, or null. */
export function webSearchEnvWarning(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.WEB_SEARCH?.trim().toLowerCase() ?? "";
  if (ENABLING_VALUES.includes(value) || DISABLING_VALUES.includes(value)) return null;
  return `WEB_SEARCH=${JSON.stringify(env.WEB_SEARCH)} is not recognised (use on, off, 1, 0, true or false); web search is disabled.`;
}

/**
 * OpenRouter request options that turn search on for `modelId`, or undefined
 * when search is off for that model (see MODELS) or the model is not listed
 * (e.g. an eval candidate). The `openrouter` keys are copied into the request
 * body by the OpenAI-compatible provider.
 */
export function webSearchProviderOptions(modelId: string): ProviderOptions | undefined {
  const engine = MODELS.find((m) => m.id === modelId)?.webSearch;
  if (engine !== "native") return undefined;
  return {
    openrouter: {
      plugins: [{ id: "web", engine: "native", max_results: WEB_SEARCH_MAX_RESULTS }],
      // How much retrieved content the provider feeds the model. "low" keeps
      // the step's input tokens small.
      web_search_options: { search_context_size: "low" },
    },
  };
}

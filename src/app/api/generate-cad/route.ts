import { allowedModelId } from "@/lib/utils";
import { liveCadWorker, openRouterModel } from "@/lib/agent-turn";
import { webSearchEnabledOnServer } from "@/lib/web-search";
import { createGenerateCadPost } from "./handler";

// Production adapters for the agent turn: OpenRouter, restricted to the model
// allowlist, the live CAD worker, and the WEB_SEARCH server switch. The
// handler lives in handler.ts.
export const POST = createGenerateCadPost({
  model: (requested) => openRouterModel(allowedModelId(requested), process.env.OPENROUTER_API_KEY),
  worker: liveCadWorker,
  webSearchAvailable: () => webSearchEnabledOnServer(),
});

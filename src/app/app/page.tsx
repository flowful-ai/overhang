import AppWorkspace from "@/components/chat/AppWorkspace";
import { webSearchEnabledOnServer } from "@/lib/web-search";

// Server component: reads the WEB_SEARCH switch and whether the OpenRouter key
// is set at request time (the /app layout is force-dynamic), so the UI can show
// search as unavailable and flag a missing key without an extra API call.
export default function AppPage() {
  return (
    <AppWorkspace
      webSearchAvailable={webSearchEnabledOnServer()}
      apiKeyMissing={!process.env.OPENROUTER_API_KEY}
    />
  );
}

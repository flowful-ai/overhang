import AppWorkspace from "@/components/chat/AppWorkspace";
import { webSearchEnabledOnServer } from "@/lib/web-search";

// Server component: reads the WEB_SEARCH switch at request time (the /app
// layout is force-dynamic) so the settings toggle can show search as
// unavailable without an extra API call.
export default function AppPage() {
  return <AppWorkspace webSearchAvailable={webSearchEnabledOnServer()} />;
}

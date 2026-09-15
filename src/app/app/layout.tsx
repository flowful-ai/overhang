import type { Metadata } from "next";
import ThemeProvider from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "App",
  robots: { index: false, follow: false },
};

// Render per request. A static prerender is served with a year-long s-maxage,
// so a CDN or proxy HTML cache could keep serving old HTML that points at
// chunks a later deploy removed.
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // Theme (light/dark) is scoped to the app workspace only, so the theme class
  // and color-scheme stay off every other route.
  return <ThemeProvider>{children}</ThemeProvider>;
}

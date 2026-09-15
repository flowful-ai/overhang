"use client";

import { ThemeProvider as NextThemeProvider } from "next-themes";

// Class-strategy theme provider. Follows the OS preference by default and lets
// the user override it with the in-app toggle; the choice is persisted to
// localStorage by next-themes.
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}

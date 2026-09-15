"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { nextThemeMode, parseThemeMode, themeModeLabel, toStoredTheme } from "@/lib/theme-mode";

const ICONS = { light: Sun, dark: Moon, auto: Monitor } as const;

// Theme button for the app header. Cycles light -> dark -> auto, where auto
// follows the OS preference live (next-themes listens to prefers-color-scheme
// and swaps the class on <html>). The icon shows the current mode.
export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Theme isn't known until after hydration; render a stable placeholder until
  // then to avoid a hydration mismatch and an icon flash. This one-shot mount
  // flag is the standard next-themes guard, so the synchronous setState here is
  // intentional.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const mode = parseThemeMode(theme);
  const Icon = mounted ? ICONS[mode] : Monitor;
  const label = mounted ? themeModeLabel(mode) : "Theme";

  return (
    <button
      type="button"
      onClick={() => setTheme(toStoredTheme(nextThemeMode(mode)))}
      className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
      aria-label={label}
      title={label}
    >
      <Icon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

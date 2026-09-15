// Theme mode logic for the app header toggle. Kept free of React and DOM
// globals so it can be unit tested in a node environment.
//
// Persistence and the pre-paint class swap are owned by next-themes (see
// ThemeProvider): it stores "light", "dark" or "system" under the "theme"
// localStorage key and resolves "system" via matchMedia before hydration.
// The UI calls that mode "auto"; this module maps between the two.

export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";
export type StoredTheme = "light" | "dark" | "system";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "auto"];
export const DEFAULT_THEME_MODE: ThemeMode = "auto";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

type MatchMedia = (query: string) => { matches: boolean };

// Parse a persisted value. Legacy "light"/"dark" keep working; "system" (what
// next-themes writes) and "auto" map to auto; anything else falls back to the
// default so a corrupted value never strands the user.
export function parseThemeMode(raw: string | null | undefined): ThemeMode {
  switch (raw) {
    case "light":
    case "dark":
      return raw;
    case "system":
    case "auto":
      return "auto";
    default:
      return DEFAULT_THEME_MODE;
  }
}

export function toStoredTheme(mode: ThemeMode): StoredTheme {
  return mode === "auto" ? "system" : mode;
}

// Resolve a mode to the concrete theme. Auto reads the OS preference; without
// matchMedia (SSR, old browsers) it falls back to light.
export function resolveThemeMode(mode: ThemeMode, matchMedia?: MatchMedia): ResolvedTheme {
  if (mode !== "auto") return mode;
  return matchMedia?.(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

// Toggle order: light -> dark -> auto -> light.
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
}

const MODE_NAMES: Record<ThemeMode, string> = {
  light: "light",
  dark: "dark",
  auto: "auto (follows system)",
};

// Accessible label: announces the current mode and what a click does.
export function themeModeLabel(mode: ThemeMode): string {
  return `Theme: ${MODE_NAMES[mode]}. Switch to ${MODE_NAMES[nextThemeMode(mode)]}.`;
}

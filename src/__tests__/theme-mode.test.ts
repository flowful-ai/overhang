import { describe, it, expect } from "vitest";
import {
  parseThemeMode,
  toStoredTheme,
  resolveThemeMode,
  nextThemeMode,
  themeModeLabel,
  DARK_SCHEME_QUERY,
  DEFAULT_THEME_MODE,
  THEME_MODES,
} from "@/lib/theme-mode";

const matchMediaStub = (dark: boolean) => {
  const queries: string[] = [];
  const fn = (query: string) => {
    queries.push(query);
    return { matches: query === DARK_SCHEME_QUERY ? dark : false };
  };
  return { fn, queries };
};

describe("parseThemeMode", () => {
  it("keeps legacy explicit values", () => {
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
  });

  it("maps system and auto to auto", () => {
    expect(parseThemeMode("system")).toBe("auto");
    expect(parseThemeMode("auto")).toBe("auto");
  });

  it("defaults new visitors and garbage to auto", () => {
    expect(DEFAULT_THEME_MODE).toBe("auto");
    expect(parseThemeMode(null)).toBe("auto");
    expect(parseThemeMode(undefined)).toBe("auto");
    expect(parseThemeMode("")).toBe("auto");
    expect(parseThemeMode("DARK")).toBe("auto");
    expect(parseThemeMode("purple")).toBe("auto");
  });
});

describe("toStoredTheme", () => {
  it("round-trips through parseThemeMode", () => {
    expect(toStoredTheme("auto")).toBe("system");
    for (const mode of THEME_MODES) {
      expect(parseThemeMode(toStoredTheme(mode))).toBe(mode);
    }
  });
});

describe("resolveThemeMode", () => {
  it("returns explicit modes without consulting matchMedia", () => {
    const stub = matchMediaStub(true);
    expect(resolveThemeMode("light", stub.fn)).toBe("light");
    expect(resolveThemeMode("dark", stub.fn)).toBe("dark");
    expect(stub.queries).toEqual([]);
  });

  it("resolves auto against prefers-color-scheme", () => {
    const dark = matchMediaStub(true);
    expect(resolveThemeMode("auto", dark.fn)).toBe("dark");
    expect(dark.queries).toEqual([DARK_SCHEME_QUERY]);
    expect(resolveThemeMode("auto", matchMediaStub(false).fn)).toBe("light");
  });

  it("falls back to light when matchMedia is unavailable", () => {
    expect(resolveThemeMode("auto")).toBe("light");
  });
});

describe("nextThemeMode", () => {
  it("cycles light -> dark -> auto -> light", () => {
    expect(nextThemeMode("light")).toBe("dark");
    expect(nextThemeMode("dark")).toBe("auto");
    expect(nextThemeMode("auto")).toBe("light");
  });
});

describe("themeModeLabel", () => {
  it("announces the current mode and the click action", () => {
    expect(themeModeLabel("light")).toBe("Theme: light. Switch to dark.");
    expect(themeModeLabel("dark")).toBe("Theme: dark. Switch to auto (follows system).");
    expect(themeModeLabel("auto")).toBe("Theme: auto (follows system). Switch to light.");
  });
});

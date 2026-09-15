import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { register } from "@/instrumentation";

// The production boot warning must follow TRUST_PROXY's hop-count semantics:
// any positive integer means "behind trusted proxies", not only the literal "1".

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const warnedAboutProxy = () =>
  vi.mocked(console.warn).mock.calls.some(([msg]) => String(msg).includes("TRUST_PROXY is not set"));

describe("instrumentation TRUST_PROXY warning", () => {
  it("warns in production when TRUST_PROXY is 0", async () => {
    vi.stubEnv("TRUST_PROXY", "0");
    await register();
    expect(warnedAboutProxy()).toBe(true);
  });

  it("does not warn for TRUST_PROXY=1", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    await register();
    expect(warnedAboutProxy()).toBe(false);
  });

  it("does not warn for a hop count above 1", async () => {
    vi.stubEnv("TRUST_PROXY", "2");
    await register();
    expect(warnedAboutProxy()).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { register } from "@/instrumentation";

// Boot checks are warnings only: there is no account or database policy left
// that could refuse to start, so register() must never exit the process.

beforeEach(() => {
  vi.resetModules();
  // register() only acts on the nodejs runtime.
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("TRUST_PROXY", "2");
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

describe("instrumentation register()", () => {
  it("boots in production with only the OpenRouter key and worker settings", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(register()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns, without exiting, when OPENROUTER_API_KEY is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await expect(register()).resolves.toBeUndefined();
    expect(process.exit).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("OPENROUTER_API_KEY is not set"));
  });

  it("warns when the generation kill switch is on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMERGENCY_DISABLE_GENERATION", "1");
    await register();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("EMERGENCY_DISABLE_GENERATION=1"));
  });

  it("warns that search is disabled when WEB_SEARCH is not recognised", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_SEARCH", "disabled");
    await register();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('WEB_SEARCH="disabled" is not recognised'));
  });

  it.each(["off", "on"])("does not warn for WEB_SEARCH=%s", async (value) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_SEARCH", value);
    await register();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("boots outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(register()).resolves.toBeUndefined();
  });

  it("does nothing outside the nodejs runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    await register();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });
});

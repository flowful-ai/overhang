import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/health/route";

const originalKey = process.env.OPENROUTER_API_KEY;
const originalUrl = process.env.CAD_WORKER_URL;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalUrl === undefined) delete process.env.CAD_WORKER_URL;
  else process.env.CAD_WORKER_URL = originalUrl;
  vi.restoreAllMocks();
});

describe("health route", () => {
  it("shallow check returns 200 + ok when env is configured", async () => {
    const res = await GET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.openrouter_key).toBe("ok");
    expect(body.checks.cad_worker).toBeUndefined();
  });

  it("shallow check returns 503 when OPENROUTER_API_KEY is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const res = await GET(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.openrouter_key).toBe("missing");
  });

  it("deep check probes the worker and reports ok when reachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );
    const res = await GET(new Request("http://localhost/api/health?deep=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.cad_worker).toBe("ok");
  });

  it("deep check returns 503 when worker is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const res = await GET(new Request("http://localhost/api/health?deep=1"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.cad_worker).toBe("unreachable");
  });
});

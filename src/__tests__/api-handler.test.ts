import { describe, it, expect } from "vitest";
import { z } from "zod";
import { withRoute } from "@/lib/api-handler";

const makeReq = (body: unknown, ip = `9.9.9.${Math.floor(Math.random() * 254) + 1}`): Request =>
  new Request("http://localhost/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });

const makeReqWithContentLength = (
  body: unknown,
  contentLength: number,
  ip = `9.9.9.${Math.floor(Math.random() * 254) + 1}`,
): Request =>
  new Request("http://localhost/test", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      "content-length": String(contentLength),
    },
    body: JSON.stringify(body),
  });

describe("withRoute", () => {
  const schema = z.object({ code: z.string().min(1, "Missing code").max(100) });

  it("invokes handler with parsed input and returns its response", async () => {
    const POST = withRoute(
      { rateKey: `t1-${Math.random()}`, rateLimit: 5, schema },
      async ({ code }) => new Response(JSON.stringify({ echoed: code }), { status: 200 }),
    );
    const res = await POST(makeReq({ code: "hello" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: "hello" });
  });

  it("returns 400 on Zod failure", async () => {
    const POST = withRoute(
      { rateKey: `t2-${Math.random()}`, rateLimit: 5, schema },
      async () => new Response("should not run"),
    );
    const res = await POST(makeReq({ code: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing code");
  });

  it("returns 400 on invalid JSON body", async () => {
    const POST = withRoute(
      { rateKey: `t3-${Math.random()}`, rateLimit: 5, schema },
      async () => new Response("should not run"),
    );
    const res = await POST(
      new Request("http://localhost/test", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "8.8.8.8" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 with sanitized message on handler throw", async () => {
    const POST = withRoute(
      { rateKey: `t4-${Math.random()}`, rateLimit: 5, schema },
      async () => {
        throw new Error("boom at /opt/secret/path");
      },
    );
    const res = await POST(makeReq({ code: "x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("/opt/secret/path");
  });

  it("rate-limits after configured limit", async () => {
    const rateKey = `t5-${Math.random()}`;
    const POST = withRoute(
      { rateKey, rateLimit: 2, schema },
      async () => new Response("ok"),
    );
    process.env.TRUST_PROXY = "1";
    const ip = "5.5.5.5";
    expect((await POST(makeReq({ code: "a" }, ip))).status).toBe(200);
    expect((await POST(makeReq({ code: "a" }, ip))).status).toBe(200);
    expect((await POST(makeReq({ code: "a" }, ip))).status).toBe(429);
    delete process.env.TRUST_PROXY;
  });

  it("returns 503 when killSwitchEnv is set to '1'", async () => {
    const envName = `KILL_T7_${Math.floor(Math.random() * 1e9)}`;
    process.env[envName] = "1";
    const POST = withRoute(
      { rateKey: `t7-${Math.random()}`, rateLimit: 5, schema, killSwitchEnv: envName },
      async () => new Response("should not run"),
    );
    const res = await POST(makeReq({ code: "x" }));
    expect(res.status).toBe(503);
    delete process.env[envName];
  });

  it("ignores killSwitchEnv when env is unset or not '1'", async () => {
    const envName = `KILL_T8_${Math.floor(Math.random() * 1e9)}`;
    const POST = withRoute(
      { rateKey: `t8-${Math.random()}`, rateLimit: 5, schema, killSwitchEnv: envName },
      async () => new Response("ok"),
    );
    expect((await POST(makeReq({ code: "x" }))).status).toBe(200);

    process.env[envName] = "0";
    expect((await POST(makeReq({ code: "x" }))).status).toBe(200);

    process.env[envName] = "true";
    expect((await POST(makeReq({ code: "x" }))).status).toBe(200);
    delete process.env[envName];
  });

  it("returns 413 when Content-Length exceeds bodyCap override", async () => {
    const POST = withRoute(
      { rateKey: `t9-${Math.random()}`, rateLimit: 5, schema, bodyCap: 100 },
      async () => new Response("should not run"),
    );
    const res = await POST(makeReqWithContentLength({ code: "x" }, 5000));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/too large/);
  });

  it("returns 413 when Content-Length exceeds the 1 MB default cap", async () => {
    const POST = withRoute(
      { rateKey: `t10-${Math.random()}`, rateLimit: 5, schema },
      async () => new Response("should not run"),
    );
    const res = await POST(makeReqWithContentLength({ code: "x" }, 2 * 1024 * 1024));
    expect(res.status).toBe(413);
  });

  it("kill switch short-circuits before rate-limit (no slot consumed)", async () => {
    const envName = `KILL_T11_${Math.floor(Math.random() * 1e9)}`;
    const rateKey = `t11-${Math.random()}`;
    const POST = withRoute(
      { rateKey, rateLimit: 1, schema, killSwitchEnv: envName },
      async () => new Response("ok"),
    );
    process.env.TRUST_PROXY = "1";
    process.env[envName] = "1";
    const ip = "6.6.6.6";
    // Two killed requests — neither should consume the single rate-limit slot.
    expect((await POST(makeReq({ code: "x" }, ip))).status).toBe(503);
    expect((await POST(makeReq({ code: "x" }, ip))).status).toBe(503);
    delete process.env[envName];
    // The slot is still available.
    expect((await POST(makeReq({ code: "x" }, ip))).status).toBe(200);
    delete process.env.TRUST_PROXY;
  });

  it("exposes req.signal to the handler via ctx", async () => {
    const POST = withRoute(
      { rateKey: `t12-${Math.random()}`, rateLimit: 5, schema },
      async (_input, { signal }) => Response.json({ hasSignal: signal instanceof AbortSignal }),
    );
    const res = await POST(makeReq({ code: "x" }));
    expect(res.status).toBe(200);
    expect((await res.json()).hasSignal).toBe(true);
  });
});

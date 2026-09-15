import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { withRoute } from "@/lib/api-handler";

// The Content-Length precheck alone is bypassable: a chunked upload has no
// Content-Length, and the header can understate the real body. withRoute also
// counts bytes as the body streams in.

const schema = z.object({ code: z.string() });

// A streamed body with no Content-Length, the way a chunked upload arrives.
const chunkedReq = (chunks: string[], extraHeaders: Record<string, string> = {}): Request =>
  new Request("http://localhost/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

describe("withRoute streaming body cap", () => {
  it("returns 413 for a chunked body over the cap with no Content-Length", async () => {
    const handler = vi.fn(async () => new Response("should not run"));
    const POST = withRoute({ rateKey: `s1-${Math.random()}`, rateLimit: 5, schema, bodyCap: 100 }, handler);
    const res = await POST(chunkedReq(['{"code":"', "x".repeat(80), "y".repeat(80), '"}']));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 413 when the body is larger than a (lying) Content-Length claims", async () => {
    const handler = vi.fn(async () => new Response("should not run"));
    const POST = withRoute({ rateKey: `s2-${Math.random()}`, rateLimit: 5, schema, bodyCap: 100 }, handler);
    const res = await POST(chunkedReq([JSON.stringify({ code: "x".repeat(500) })], { "content-length": "10" }));
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("parses a chunked body under the cap, reassembling split multi-byte characters", async () => {
    const POST = withRoute(
      { rateKey: `s3-${Math.random()}`, rateLimit: 5, schema, bodyCap: 100 },
      async ({ code }) => Response.json({ code }),
    );
    const bytes = new TextEncoder().encode(JSON.stringify({ code: "é-ok" }));
    // "é" is two bytes at offsets 9-10; split between them.
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 10));
          controller.enqueue(bytes.slice(10));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "é-ok" });
  });

  it("still returns 400 for an invalid JSON body under the cap", async () => {
    const POST = withRoute(
      { rateKey: `s4-${Math.random()}`, rateLimit: 5, schema, bodyCap: 100 },
      async () => new Response("should not run"),
    );
    expect((await POST(chunkedReq(["not json"]))).status).toBe(400);
  });
});

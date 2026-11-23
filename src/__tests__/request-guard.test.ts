import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { allowedHosts, checkRequestOrigin, hostnameOf, isPrivateName } from "@/lib/request-guard";
import { withRoute } from "@/lib/api-handler";

const req = (headers: Record<string, string>, url = "http://localhost:3000/api/render-cad") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ code: "x" }),
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hostnameOf / isPrivateName / allowedHosts", () => {
  it("drops the port and keeps IPv6 brackets", () => {
    expect(hostnameOf("Example.com:8443")).toBe("example.com");
    expect(hostnameOf("localhost")).toBe("localhost");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
  });

  it.each(["localhost", "app.localhost", "127.0.0.1", "192.168.1.20", "[::1]", "nas", "printer.local", "nas.lan", "cad.internal", "box.home.arpa"])(
    "treats %s as a name public DNS cannot serve",
    (name) => expect(isPrivateName(name)).toBe(true),
  );

  it.each(["evil.example", "localhost.evil.example", "127.0.0.1.evil.example", "cad.example.com", "999.1.1.1", ""])(
    "treats %s as a public name",
    (name) => expect(isPrivateName(name)).toBe(false),
  );

  it("parses ALLOWED_HOSTS, ignoring schemes, ports, paths and blanks", () => {
    expect([...allowedHosts({ ALLOWED_HOSTS: " Cad.Example.com, https://b.example:8443/, ,c.example:3000" })]).toEqual([
      "cad.example.com",
      "b.example",
      "c.example",
    ]);
    expect(allowedHosts({}).size).toBe(0);
  });
});

describe("checkRequestOrigin", () => {
  it("accepts the app's own requests on a local install", () => {
    expect(checkRequestOrigin(req({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))).toBeNull();
  });

  it("accepts a non-browser client that sends neither Origin nor Sec-Fetch-Site", () => {
    expect(checkRequestOrigin(req({ host: "127.0.0.1:3000" }))).toBeNull();
  });

  it("falls back to the request URL when there is no Host header", () => {
    expect(checkRequestOrigin(req({}))).toBeNull();
  });

  it.each(["cross-site", "same-site"])("refuses a %s request, whatever its Origin says", (site) => {
    const failure = checkRequestOrigin(req({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": site }));
    expect(failure).toEqual({ status: 403, error: "Cross-site requests are not accepted." });
  });

  it("refuses a foreign Origin when the browser sends no Sec-Fetch-Site (plain http on a LAN address)", () => {
    expect(checkRequestOrigin(req({ host: "192.168.1.20:3000", origin: "http://evil.example" }))?.status).toBe(403);
    expect(checkRequestOrigin(req({ host: "192.168.1.20:3000", origin: "http://192.168.1.20:3000" }))).toBeNull();
  });

  it("refuses another port on the same machine and an opaque origin", () => {
    expect(checkRequestOrigin(req({ host: "localhost:3000", origin: "http://localhost:5173" }))?.status).toBe(403);
    expect(checkRequestOrigin(req({ host: "localhost:3000", origin: "null" }))?.status).toBe(403);
  });

  it("refuses DNS rebinding: a public name pointed at the app is same-origin to the browser", () => {
    const failure = checkRequestOrigin(req({ host: "evil.example:3000", origin: "http://evil.example:3000" }));
    expect(failure?.status).toBe(403);
    expect(failure?.error).toContain('Host "evil.example" is not allowed');
    expect(failure?.error).toContain("ALLOWED_HOSTS");
  });

  it("serves a public name once it is listed in ALLOWED_HOSTS", () => {
    vi.stubEnv("ALLOWED_HOSTS", "cad.example.com");
    const own = { host: "cad.example.com", origin: "https://cad.example.com", "sec-fetch-site": "same-origin" };
    expect(checkRequestOrigin(req(own))).toBeNull();
    expect(checkRequestOrigin(req({ host: "evil.example", origin: "http://evil.example" }))?.status).toBe(403);
  });

  it("still requires a public name to be listed behind a declared proxy, unless ALLOWED_HOSTS is *", () => {
    // TRUST_PROXY is about X-Forwarded-For. Compose falls back to 1 when .env
    // has no TRUST_PROXY line, so it must not switch the Host check off.
    vi.stubEnv("TRUST_PROXY", "1");
    const own = { host: "cad.example.com", origin: "https://cad.example.com", "sec-fetch-site": "same-origin" };
    expect(checkRequestOrigin(req(own))?.status).toBe(403);
    vi.stubEnv("ALLOWED_HOSTS", "*");
    expect(checkRequestOrigin(req(own))).toBeNull();
    // The wildcard is for Host only: a cross-site request is still refused.
    expect(checkRequestOrigin(req({ ...own, "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(checkRequestOrigin(req({ host: "cad.example.com", origin: "https://evil.example" }))?.status).toBe(403);
  });

  it("matches the Origin against the public name when a proxy rewrites Host", () => {
    // nginx without `proxy_set_header Host $host`, on plain http so the
    // browser sends no Sec-Fetch-Site.
    const rewritten = { host: "127.0.0.1:3000", origin: "http://nas.lan" };
    expect(checkRequestOrigin(req(rewritten))?.status).toBe(403);
    vi.stubEnv("ALLOWED_HOSTS", "nas.lan");
    expect(checkRequestOrigin(req(rewritten))).toBeNull();
    vi.stubEnv("ALLOWED_HOSTS", "");
    // X-Forwarded-Host counts only when a proxy is declared.
    expect(checkRequestOrigin(req({ ...rewritten, "x-forwarded-host": "nas.lan" }))?.status).toBe(403);
    vi.stubEnv("TRUST_PROXY", "1");
    expect(checkRequestOrigin(req({ ...rewritten, "x-forwarded-host": "nas.lan" }))).toBeNull();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
    "refuses a %s body, the only kinds a cross-site form or no-cors fetch can send",
    (contentType) => {
      expect(checkRequestOrigin(req({ host: "localhost:3000", "content-type": contentType }))).toEqual({
        status: 415,
        error: "Content-Type must be application/json.",
      });
    },
  );

  it("accepts a JSON content type with parameters", () => {
    expect(checkRequestOrigin(req({ host: "localhost:3000", "content-type": "Application/JSON; charset=utf-8" }))).toBeNull();
  });
});

describe("withRoute applies the guard before any work", () => {
  const schema = z.object({ code: z.string() });

  it("refuses a cross-site text/plain POST without running the handler or spending rate limit", async () => {
    let ran = 0;
    const POST = withRoute({ rateKey: `guard-${Math.random()}`, rateLimit: 1, schema }, async () => {
      ran++;
      return new Response("ok");
    });
    // What `fetch(url, { method: "POST", mode: "no-cors", body: json })` sends.
    const attack = () =>
      new Request("http://localhost:3000/api/render-cad", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ code: "x" }),
      });
    for (let i = 0; i < 3; i++) {
      const res = await POST(attack());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Cross-site requests are not accepted." });
    }
    expect(ran).toBe(0);
    // The single rate-limit slot is still free for the real client.
    expect((await POST(req({ host: "localhost:3000", "sec-fetch-site": "same-origin" }))).status).toBe(200);
    expect(ran).toBe(1);
  });
});

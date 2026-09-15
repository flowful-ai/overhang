import { describe, it, expect, afterEach, vi } from "vitest";
import { checkRateLimit, getClientIp, normalizeIpKey, trustedProxyHops } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    const key = `test-under-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5)).toBe(true);
    }
  });

  it("blocks requests at/over the limit", () => {
    const key = `test-over-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(key, 3)).toBe(true);
    }
    expect(checkRateLimit(key, 3)).toBe(false);
    expect(checkRateLimit(key, 3)).toBe(false);
  });

  it("keys are isolated from each other", () => {
    const keyA = `test-iso-a-${Math.random()}`;
    const keyB = `test-iso-b-${Math.random()}`;
    expect(checkRateLimit(keyA, 1)).toBe(true);
    expect(checkRateLimit(keyA, 1)).toBe(false);
    // keyB should still have its full allowance
    expect(checkRateLimit(keyB, 1)).toBe(true);
  });
});

const req = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

describe("trustedProxyHops", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["true", 0],
    ["-1", 0],
    ["1.5", 0],
    ["1", 1],
    ["2", 2],
  ])("TRUST_PROXY=%s -> %i hops", (value, hops) => {
    if (value === undefined) vi.stubEnv("TRUST_PROXY", undefined as unknown as string);
    else vi.stubEnv("TRUST_PROXY", value);
    expect(trustedProxyHops()).toBe(hops);
  });
});

describe("getClientIp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ignores every forwarding header by default (not spoofable)", () => {
    vi.stubEnv("TRUST_PROXY", "");
    const spoofed = req({ "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8", "x-real-ip": "9.9.9.9" });
    // All untrusted traffic collapses into a single shared bucket
    expect(getClientIp(spoofed)).toBe(getClientIp(req({})));
  });

  it("with one trusted proxy, uses the entry that proxy appended, not the client-supplied leftmost", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    // Client sent "X-Forwarded-For: 6.6.6.6"; the proxy appended the real peer.
    expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("rotating the spoofed prefix does not change the bucket", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const a = getClientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }));
    const b = getClientIp(req({ "x-forwarded-for": "2.2.2.2, 3.3.3.3, 203.0.113.7" }));
    expect(a).toBe(b);
  });

  it("with n trusted proxies, counts n entries from the right", () => {
    vi.stubEnv("TRUST_PROXY", "2");
    // spoofed, client (written by outer proxy), outer proxy (written by inner proxy)
    expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" }))).toBe("203.0.113.7");
  });

  it("falls back to the leftmost entry when there are fewer entries than trusted hops", () => {
    vi.stubEnv("TRUST_PROXY", "3");
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" }))).toBe("203.0.113.7");
  });

  it("ignores CF-Connecting-IP when only TRUST_PROXY is set (Cloudflare bypass can forge it)", () => {
    vi.stubEnv("TRUST_PROXY", "2");
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "");
    // Attacker hits Traefik directly: forged CF header, XFF with a forged entry
    // plus the attacker's real address appended by Traefik.
    const a = req({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9, 203.0.113.7, 172.70.1.1" });
    const b = req({ "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "9.9.9.9, 203.0.113.7, 172.70.1.1" });
    expect(getClientIp(a)).toBe("203.0.113.7");
    expect(getClientIp(b)).toBe(getClientIp(a));
  });

  it("uses CF-Connecting-IP when TRUST_CF_CONNECTING_IP=1", () => {
    vi.stubEnv("TRUST_PROXY", "2");
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    const r = req({ "cf-connecting-ip": " 198.51.100.4 ", "x-forwarded-for": "6.6.6.6, 172.70.1.1" });
    expect(getClientIp(r)).toBe("198.51.100.4");
  });

  it("falls back to X-Forwarded-For hop counting in CF mode when the header is absent", () => {
    vi.stubEnv("TRUST_PROXY", "2");
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 172.70.1.1" }))).toBe("203.0.113.7");
  });

  it("CF mode alone (TRUST_PROXY=0) uses the CF header but still ignores X-Forwarded-For", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    vi.stubEnv("TRUST_CF_CONNECTING_IP", "1");
    expect(getClientIp(req({ "cf-connecting-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6" }))).toBe(getClientIp(req({})));
  });

  it("keys IPv6 clients by /64 and IPv4-mapped addresses as IPv4", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const v6a = getClientIp(req({ "x-forwarded-for": "2001:db8:abcd:12::1" }));
    const v6b = getClientIp(req({ "x-forwarded-for": "2001:DB8:abcd:12:ffff:1:2:3" }));
    expect(v6a).toBe("2001:db8:abcd:12::/64");
    expect(v6b).toBe(v6a);
    expect(getClientIp(req({ "x-forwarded-for": "::ffff:203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("trims whitespace and ignores empty entries", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(getClientIp(req({ "x-forwarded-for": "  5.6.7.8  ,  9.9.9.9 , " }))).toBe("9.9.9.9");
  });

  it("honors x-real-ip as a last resort when trusted", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(getClientIp(req({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });
});

describe("normalizeIpKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    [" 203.0.113.7:51234 ", "203.0.113.7"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["::FFFF:1.2.3.4", "1.2.3.4"],
    ["::ffff:102:304", "1.2.3.4"],
    ["[::ffff:1.2.3.4]:443", "1.2.3.4"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8:0:0::/64"],
    ["[2001:db8:1:2::5]:8080", "2001:db8:1:2::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["2001:db8:1:2:3:4:5.6.7.8", "2001:db8:1:2::/64"],
    ["not-an-ip", "not-an-ip"],
    ["1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
    ["999.1.1.1", "999.1.1.1"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeIpKey(input)).toBe(expected);
  });
});

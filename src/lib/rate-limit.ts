// Fixed-window-ish sliding limiter backed by an in-process Map.
//
// SCOPE: the store is per server instance and resets on restart. With N app
// instances the effective limit is roughly limit*N, since each instance counts
// only the traffic it sees. That's acceptable for the single-instance compose
// deploy this targets; a multi-instance deployment should swap this for a
// shared store (e.g. Redis INCR with expiry).
const WINDOW_MS = 60_000; // 1 minute

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes (guarded against HMR re-registration)
let cleanupScheduled = false;
if (typeof globalThis !== "undefined" && !cleanupScheduled) {
  cleanupScheduled = true;
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }, 5 * 60_000).unref?.();
}

/**
 * Returns true if the request is allowed, false if rate-limited.
 * @param key - unique identifier (e.g. client IP)
 * @param limit - max requests per 1-minute window
 */
export function checkRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const entry = store.get(key) || { timestamps: [] };
  entry.timestamps = entry.timestamps.filter(t => t > cutoff);

  if (entry.timestamps.length >= limit) {
    return false;
  }

  entry.timestamps.push(now);
  store.set(key, entry);
  return true;
}

/**
 * Shared key used for all requests when no trusted proxy is configured. All
 * untrusted traffic collapses into a single bucket (coarse but non-spoofable).
 */
const UNTRUSTED_IP_KEY = "anon";

/**
 * Number of trusted reverse proxies in front of the app, from `TRUST_PROXY`.
 * Unset, `0`, or anything that isn't a positive integer means "trust nothing".
 * `1` is one proxy (e.g. Traefik); `2` is two chained proxies (e.g. Cloudflare
 * then Traefik), and so on.
 */
export function trustedProxyHops(): number {
  const n = Number(process.env.TRUST_PROXY);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Whether `CF-Connecting-IP` is trusted, from `TRUST_CF_CONNECTING_IP=1`.
 * Separate from TRUST_PROXY on purpose: anyone who reaches the origin without
 * going through Cloudflare can set this header to any value, so it is only safe
 * when the origin accepts traffic from Cloudflare alone (firewalled to
 * Cloudflare's IP ranges, or Authenticated Origin Pulls).
 */
export function trustsCloudflareHeader(): boolean {
  return process.env.TRUST_CF_CONNECTING_IP === "1";
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every(o => Number(o) <= 255);
}

// Expands an IPv6 address to its 8 groups (numbers), or null when malformed.
// A trailing dotted IPv4 (e.g. ::ffff:1.2.3.4) counts as the last two groups.
function ipv6Groups(addr: string): number[] | null {
  let s = addr;
  // Rewrite a dotted IPv4 tail as its two hex groups: ::ffff:1.2.3.4 -> ::ffff:102:304
  const tail = /(^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    if (!isIpv4(tail[2])) return null;
    const o = tail[2].split(".").map(Number);
    const hex = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    s = s.slice(0, s.length - tail[2].length) + hex;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups.map(g => parseInt(g, 16)) : null;
}

/**
 * Canonical rate-limit key for a client address.
 * - IPv4 stays as is; a port suffix (`1.2.3.4:5678`) is dropped.
 * - IPv4-mapped IPv6 (`::ffff:1.2.3.4`, `::ffff:102:304`) becomes plain IPv4,
 *   so one client can't get two buckets by switching notation.
 * - Other IPv6 collapses to its /64 prefix (`2001:db8:0:1::/64`): a single
 *   subscriber is routinely handed a whole /64, so per-address keys would let
 *   them rotate through billions of fresh buckets.
 * Anything unparseable is returned trimmed and lowercased.
 */
export function normalizeIpKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4port) s = v4port[1];
  if (isIpv4(s)) return s;
  s = s.replace(/%.*$/, ""); // zone id (fe80::1%eth0)
  const g = ipv6Groups(s);
  if (!g) return raw.trim().toLowerCase();
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map(x => x.toString(16)).join(":")}::/64`;
}

/**
 * Extract the client identity for rate-limiting.
 *
 * With `TRUST_PROXY` unset or 0 (and no Cloudflare trust), no header is
 * trusted: every client controls `X-Forwarded-For`, so all traffic shares one
 * bucket.
 *
 * - `TRUST_CF_CONNECTING_IP=1`: `CF-Connecting-IP` wins when present.
 * - `TRUST_PROXY=n` (n trusted proxies): `X-Forwarded-For` is read from the
 *   RIGHT. Each proxy appends the address it received the request from, so the
 *   entry n positions from the end is the one the outermost trusted proxy
 *   wrote. Anything left of it is client-supplied and never used.
 *   `X-Real-IP` is the last resort, for proxies that set only that header.
 *
 * Both are only as trustworthy as the network path: if the origin is reachable
 * around the proxies, a client can write these headers itself.
 */
export function getClientIp(request: Request): string {
  if (trustsCloudflareHeader()) {
    const cf = request.headers.get("cf-connecting-ip")?.trim();
    if (cf) return normalizeIpKey(cf);
  }

  const hops = trustedProxyHops();
  if (hops === 0) return UNTRUSTED_IP_KEY;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded.split(",").map(s => s.trim()).filter(Boolean);
    if (entries.length > 0) {
      // Fewer entries than trusted hops means the request skipped a proxy; the
      // leftmost entry is then still one a trusted proxy wrote.
      return normalizeIpKey(entries[Math.max(0, entries.length - hops)]);
    }
  }

  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return normalizeIpKey(real);
  return UNTRUSTED_IP_KEY;
}

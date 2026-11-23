import { isIpv4, trustedProxyHops, trustsCloudflareHeader } from "./rate-limit";

// Cross-site request guard for the POST routes (applied by withRoute).
//
// There are no accounts, so the browser is the only thing standing between a
// web page the operator happens to visit and this API: without a check, any
// site could POST to http://localhost:3000/api/render-cad and run Python in
// the worker, or to /api/generate-cad and spend the OpenRouter key. Binding to
// loopback does not help, the request comes from the operator's own browser.
//
// Three checks, each closing a different door:
// 1. Host allowlist: DNS rebinding. A page on evil.example re-points its own
//    name at 127.0.0.1, so its requests are same-origin to the browser and
//    only the Host header gives it away.
// 2. Sec-Fetch-Site / Origin: plain cross-site requests.
// 3. Content-Type: application/json. A cross-site form or no-cors fetch can
//    only send form and text/plain bodies; JSON needs a CORS preflight, which
//    the app never grants. Catches browsers that send neither header above.
//
// This is not authentication: a non-browser client can send any header. It
// only stops browsers from being used against their owner.

export interface GuardFailure {
  status: 403 | 415;
  error: string;
}

/**
 * Hostnames from ALLOWED_HOSTS (comma-separated; a scheme or port is ignored),
 * lowercased. A lone `*` entry accepts any Host (see checkRequestOrigin).
 */
export function allowedHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>();
  for (const raw of (env.ALLOWED_HOSTS ?? "").split(",")) {
    const name = hostnameOf(raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, ""));
    if (name) out.add(name);
  }
  return out;
}

/** The hostname of a Host header value: port dropped, IPv6 brackets kept, lowercased. */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  return h.replace(/:\d*$/, "");
}

// Suffixes that public DNS never serves, so an attacker cannot own a name
// under them: reserved (localhost, local, internal, home.arpa) or the usual
// home-router zone (lan).
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/**
 * Whether `hostname` cannot be a public DNS name an attacker controls: an IP
 * literal (the browser went to that address, nothing was resolved), localhost,
 * a single-label name, or a name under a private suffix. DNS rebinding needs a
 * public name, so these are safe to serve without configuration.
 */
export function isPrivateName(hostname: string): boolean {
  if (hostname === "") return false;
  if (hostname.startsWith("[")) return true; // IPv6 literal
  if (isIpv4(hostname)) return true;
  if (!hostname.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function behindTrustedProxy(): boolean {
  return trustedProxyHops() > 0 || trustsCloudflareHeader();
}

/** Whether the browser (or, failing that, the Origin header) says another site sent `req`. */
function isCrossSite(req: Request, host: string, allowed: Set<string>): boolean {
  // Set by the browser, and JavaScript cannot forge it. Only sent to https and
  // loopback URLs, hence the Origin fallback.
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site) return site !== "same-origin" && site !== "none";

  // No Origin either: not a browser (curl, a script). Browsers send it on
  // every cross-origin POST.
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return true; // "null": a sandboxed frame or a file:// page
  }
  // A proxy that rewrites Host reports the public name here; believed only
  // when the operator declared a proxy.
  const forwardedHost = behindTrustedProxy()
    ? req.headers.get("x-forwarded-host")?.split(",")[0].trim().toLowerCase()
    : undefined;
  return url.host !== host && url.host !== forwardedHost && !allowed.has(hostnameOf(url.host));
}

/** Returns why `req` is refused, or null when it may proceed. */
export function checkRequestOrigin(req: Request): GuardFailure | null {
  const host = (req.headers.get("host") ?? new URL(req.url).host).trim().toLowerCase();
  const hostname = hostnameOf(host);
  const allowed = allowedHosts();

  // Fails closed for a public name: the operator lists it, or opts out with
  // `*` when something in front already pins the hostnames that reach the app.
  if (!allowed.has("*") && !allowed.has(hostname) && !isPrivateName(hostname)) {
    return {
      status: 403,
      error: `Host "${hostname.slice(0, 100)}" is not allowed. To serve Overhang under this name, add it to ALLOWED_HOSTS in .env and restart.`,
    };
  }

  if (isCrossSite(req, host, allowed)) {
    return { status: 403, error: "Cross-site requests are not accepted." };
  }

  const contentType = req.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { status: 415, error: "Content-Type must be application/json." };
  }
  return null;
}

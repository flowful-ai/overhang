# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue.

- **Preferred:** GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- **Fallback:** email hello@flowful.ai.

Include the affected component (frontend, CAD worker, Compose setup), steps to reproduce, and the impact you observed.

## Supported versions

Only `main` is supported. Fixes land on `main`; there are no maintained release branches. Pull the latest `main` and rebuild (`docker compose up --build`) to get them.

## Scope notes

Overhang is self-hosted: whoever runs an install operates it.

- **The CAD worker executes LLM-generated Python, and anyone who can reach the app can send it their own.** Treat a render as arbitrary code running as the worker's non-root user. The restricted `exec()` in `cad-worker/main.py` (import allowlist, trimmed builtins, parse-time rejection of dunder access) is defence in depth, not a security boundary: `os` is one public attribute away (`cq.exporters.os`), and from there a script can start a shell. The worker container is the isolation boundary: non-root user, all capabilities dropped, read-only root filesystem, `no-new-privileges`, CPU, memory and process limits, no port published to the host, and no network route except to the frontend.
- **The worker has no outbound network in the default `docker-compose.yml`.** It sits alone with the frontend on an `internal` Docker network, so generated code cannot call the internet, your LAN or a cloud metadata endpoint. Use Docker Engine 26 or later: older engines still forwarded DNS lookups from internal networks, which leaves a slow way to leak data. It can still call the frontend's API, like any other client. If you run the worker another way (plain `docker run`, Kubernetes, the host), block its egress yourself.
- **Worth reporting:** escapes from the worker container to host processes or files, reading other containers' secrets or environment from generated code, bypasses of the worker secret, rate limits, request size caps or input validation, and leaks of the operator's API keys.
- **Also welcome, lower severity:** bypasses of the restricted `exec()` that stay confined to the worker container.
- **Out of scope:** issues that require a deployment to ignore the guidance in [docs/configuration.md](docs/configuration.md#running-behind-a-proxy) (for example `TRUST_CF_CONNECTING_IP=1` on an origin reachable without Cloudflare), and vulnerabilities in dependencies with no exploit path in Overhang (report those upstream).

## Built-in protections

- **No accounts.** Anyone who can reach the app generates designs on the operator's OpenRouter key. Compose publishes port 3000 on loopback (`FRONTEND_BIND`); access control in front of a public install is the operator's job.
- **Cross-site requests are refused.** A loopback bind does not stop a web page open in your browser from calling `http://localhost:3000`. The API routes accept a POST only when the browser marks it same-origin (`Sec-Fetch-Site`, or an `Origin` that matches the app), the body is `application/json` (which a cross-site form or `no-cors` fetch cannot send), and the `Host` is one the app is meant to serve: localhost, an IP address, a private name, or an entry in `ALLOWED_HOSTS`. The last check is what stops DNS rebinding. See [docs/configuration.md](docs/configuration.md#cross-site-requests). This is not authentication: a script or `curl` can send any header.
- **Python sandbox.** Trimmed `__builtins__` (`exec`, `eval`, `open`, `compile`, `getattr`, `setattr`, `type`, `object` removed), an `__import__` allowlist (`math`, `cadquery`, `numpy`, `itertools`, `functools`, `collections`), and parse-time rejection of dunder access. It keeps honest mistakes and casual attempts out; it does not hold against a deliberate script. The modules it must expose reach the rest of the standard library through their own attributes, so file reads (`np.loadtxt`), `os` and a shell are all available to a script that goes looking.
- **Render process isolation.** Each render and export runs in its own child process, forked from a forkserver that never runs user code, so state a script changes does not reach the next request. The child is killed with SIGKILL at `EXEC_TIMEOUT`, together with the processes it started that stayed in its process group, and has `RLIMIT_AS` (`CAD_RENDER_MEMORY_MB`) and `RLIMIT_CPU` caps. Known limit: a process that detaches itself (`setsid`) leaves that group and outlives the render. It keeps the worker user's rights until the container restarts, so it can read what later renders write to `/tmp`. The only thing it can reach over the network is the frontend's API, where it can start generations on the OpenRouter key like any client that reaches the app (the per-IP rate limit does not hold it back when `TRUST_PROXY` is set, since it can send its own `X-Forwarded-For`; the concurrency cap and the kill switch do), and `pids_limit` and the container's memory limit bound how many such processes can pile up. On an install shared between people who do not trust each other, restart the worker (`docker compose restart cad-worker`) to clear them. `WORKER_SECRET` is removed from the environment before the forkserver starts, and the API process is non-dumpable, so a render can read neither its own environment's secret nor the parent's `/proc/<pid>/environ`. The Compose healthcheck drops it from its environment too. Any other process started in the container with its environment (`docker exec`) shares the render's uid and exposes the secret in `/proc/<pid>/environ` while it runs.
- **Worker auth.** `/render` and `/export-3mf` require a matching `X-Worker-Secret` header (`WORKER_SECRET`), which blocks requests from inside the Docker network that CORS cannot stop.
- **Rate limiting.** Per IP: `/api/generate-cad` 10/min, `/api/render-cad` and `/api/export-3mf` 20/min. The client IP comes from proxy headers only when `TRUST_PROXY` or `TRUST_CF_CONNECTING_IP` is set, never from the client-controlled left end of `X-Forwarded-For`. IPv6 clients are keyed by /64. The store is in memory, per instance.
- **Concurrency.** All callers share a global pool per endpoint (`MAX_CONCURRENT_GENERATIONS`, `MAX_CONCURRENT_RENDERS`); over the cap the route returns 503.
- **Cost controls.** A hard `maxOutputTokens` per step, an 8-step agent loop, a 240 s turn timeout, and `EMERGENCY_DISABLE_GENERATION=1` as a kill switch.
- **Input validation.** AI SDK UI message validation, user and assistant roles only, 10,000-character prompts, inline images only (2 MB for the image being sent; unusable images in older turns are dropped with a placeholder), code length, model allowlist, a 200-message history cap, and a request body cap (10 MB on generate-cad, 1 MB on the render and export routes) counted as the body streams, so chunked uploads cannot skip it.
- **HTTP headers.** CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (see `next.config.ts`).
- **Sanitized errors.** Paths are stripped from error text before it reaches the user or the LLM.

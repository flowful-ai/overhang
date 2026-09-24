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

- **The CAD worker executes LLM-generated Python.** The restricted `exec()` in `cad-worker/main.py` (import allowlist, trimmed builtins, parse-time rejection of dunder access) is defence in depth, not a security boundary. The worker container is the real isolation boundary: non-root user, all capabilities dropped, read-only root filesystem, `no-new-privileges`, CPU and memory limits, no port published to the host.
- **The worker can reach the network.** In the default `docker-compose.yml` it sits on a normal bridge network, so outbound connections are not blocked. Operators who need egress blocked must add host firewall or egress rules for the worker container themselves (for example in the `DOCKER-USER` iptables chain).
- **Worth reporting:** escapes from the worker container to host processes or files, reading other containers' secrets or environment from generated code, bypasses of the worker secret, rate limits, request size caps or input validation, and leaks of the operator's API keys.
- **Also welcome, lower severity:** bypasses of the restricted `exec()` that stay confined to the worker container.
- **Out of scope:** issues that require a deployment to ignore the guidance in [docs/configuration.md](docs/configuration.md#running-behind-a-proxy) (for example `TRUST_CF_CONNECTING_IP=1` on an origin reachable without Cloudflare), and vulnerabilities in dependencies with no exploit path in Overhang (report those upstream).

## Built-in protections

- **No accounts.** Anyone who can reach the app generates designs on the operator's OpenRouter key. Compose publishes port 3000 on loopback (`FRONTEND_BIND`); access control in front of a public install is the operator's job.
- **Python sandbox.** Trimmed `__builtins__` (`exec`, `eval`, `open`, `compile`, `getattr`, `setattr`, `type`, `object` removed), an `__import__` allowlist (`math`, `cadquery`, `numpy`, `itertools`, `functools`, `collections`), and parse-time rejection of dunder access. The sandbox does not block file reads: numpy (`np.loadtxt`) and CadQuery's importers can read any file the worker user can. numpy stays in the allowlist because the agent's system prompt offers it; removing it would not close file access.
- **Render process isolation.** Each render and export runs in its own child process, forked from a forkserver that never runs user code, so state a script changes does not reach the next request. The child is killed with SIGKILL at `EXEC_TIMEOUT` and has `RLIMIT_AS` (`CAD_RENDER_MEMORY_MB`) and `RLIMIT_CPU` caps. `WORKER_SECRET` is removed from the environment before the forkserver starts, and the API process is non-dumpable, so a render can read neither its own environment's secret nor the parent's `/proc/<pid>/environ`. The Compose healthcheck drops it from its environment too. Any other process started in the container with its environment (`docker exec`) shares the render's uid and exposes the secret in `/proc/<pid>/environ` while it runs.
- **Worker auth.** `/render` and `/export-3mf` require a matching `X-Worker-Secret` header (`WORKER_SECRET`), which blocks requests from inside the Docker network that CORS cannot stop.
- **Rate limiting.** Per IP: `/api/generate-cad` 10/min, `/api/render-cad` and `/api/export-3mf` 20/min. The client IP comes from proxy headers only when `TRUST_PROXY` or `TRUST_CF_CONNECTING_IP` is set, never from the client-controlled left end of `X-Forwarded-For`. IPv6 clients are keyed by /64. The store is in memory, per instance.
- **Concurrency.** All callers share a global pool per endpoint (`MAX_CONCURRENT_GENERATIONS`, `MAX_CONCURRENT_RENDERS`); over the cap the route returns 503.
- **Cost controls.** A hard `maxOutputTokens` per turn, a 5-step agent loop, and `EMERGENCY_DISABLE_GENERATION=1` as a kill switch.
- **Input validation.** AI SDK UI message validation, user and assistant roles only, 10,000-character prompts, inline images only (2 MB for the image being sent; unusable images in older turns are dropped with a placeholder), code length, model allowlist, a 200-message history cap, and a request body cap (10 MB on generate-cad, 1 MB on the render and export routes) counted as the body streams, so chunked uploads cannot skip it.
- **HTTP headers.** CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (see `next.config.ts`).
- **Sanitized errors.** Paths are stripped from error text before it reaches the user or the LLM.

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
- **The worker can reach the network.** In the default `docker-compose.yml` it sits on a normal bridge network, so outbound connections are not blocked. Operators who need egress blocked must add firewall or egress rules themselves.
- **Worth reporting:** escapes from the worker container to host processes or files, reading other containers' secrets or environment from generated code, bypasses of the worker secret, rate limits, request size caps or input validation, and leaks of the operator's API keys.
- **Also welcome, lower severity:** bypasses of the restricted `exec()` that stay confined to the worker container.
- **Out of scope:** issues that require a deployment to ignore the README guidance (for example `TRUST_CF_CONNECTING_IP=1` on an origin reachable without Cloudflare), and vulnerabilities in dependencies with no exploit path in Overhang (report those upstream).

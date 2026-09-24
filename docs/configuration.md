# Configuration

Overhang reads its settings from `.env`, which `setup.sh` creates from `.env.example`. Restart with `docker compose up -d --build --remove-orphans` after a change.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | Yes | - | [Get one here](https://openrouter.ai/keys). The only LLM credential. |
| `WORKER_SECRET` | Yes (Compose) | unset | Shared secret between the frontend and the CAD worker, so nothing else on the Docker network can drive arbitrary Python execution. `docker-compose.yml` refuses to start without it; `setup.sh` generates it. Set the same value on both services. Generate with `openssl rand -hex 32`. |
| `CAD_WORKER_URL` | No | `http://localhost:8000` | Python worker URL. Compose sets `http://cad-worker:8000`. |
| `ALLOWED_ORIGINS` | No | `http://frontend:3000` | CORS allowlist for the worker (code fallback when unset is `*`). |
| `EXEC_TIMEOUT` | No | `30` | Max CAD execution time, in seconds. |
| `CAD_MAX_CONCURRENT_RENDERS` | No | `4` | Max simultaneous renders in the worker. Over it, the worker sheds load with 503. |
| `TRUST_PROXY` | No | `0` (`.env.example`), `1` (Compose without a `.env` value) | Number of trusted proxies that append to `X-Forwarded-For`. See [Running behind a proxy](#running-behind-a-proxy). |
| `TRUST_CF_CONNECTING_IP` | No | unset | `1` keys the rate limiter on `CF-Connecting-IP`. See [Cloudflare](#cloudflare). |
| `FRONTEND_BIND` | No | `127.0.0.1` | Host interface Compose publishes port 3000 on. Keeps other machines off port 3000; it does not firewall your proxy. |
| `MAX_CONCURRENT_GENERATIONS` | No | `4` | Max simultaneous `/api/generate-cad` turns, shared by all callers. Over it: 503. Falls back to the older `ANON_MAX_CONCURRENT_GENERATIONS`. |
| `MAX_CONCURRENT_RENDERS` | No | `4` | Same, for `/api/render-cad` and `/api/export-3mf` (one shared pool). Falls back to `ANON_MAX_CONCURRENT_RENDERS`. |
| `EMERGENCY_DISABLE_GENERATION` | No | unset | `1` forces `/api/generate-cad` to return 503. Kill switch for cost incidents. |
| `WEB_SEARCH` | No | on | See [Web search](#web-search). |
| `LOG_LEVEL` | No | `INFO` | CAD worker log level. |

## Web search

The agent can look up product specs through OpenRouter web search, on the first step of a turn only. The model decides how many queries that step runs, and each is billed by the provider (about $0.01 per query on GPT-5.6 Luna). It is enabled per model in `MODELS` (`src/lib/utils.ts`), currently GPT-5.6 Luna only.

Only unset, empty, `on`, `1` or `true` enable it. Any other value, such as `off`, disables it for everyone and greys out the toggle in Settings. Users can also turn it off in Settings.

## Running behind a proxy

A local install needs none of this. If you serve Overhang from a server or behind a reverse proxy:

- **Access.** There are no accounts, so anyone who reaches the app spends your OpenRouter credits. Put access control (proxy auth, VPN) in front of it unless it is meant to be open.
- **Port bind.** Compose publishes port 3000 on `FRONTEND_BIND` (default `127.0.0.1`). A proxy on the same host reaches it there or over the Docker network. Set `FRONTEND_BIND=0.0.0.0` only if the proxy runs on another machine, and firewall port 3000 to that proxy.
- **Client IP.** Set `TRUST_PROXY` to the number of trusted proxies that append to `X-Forwarded-For`: `1` behind one reverse proxy (nginx, Caddy, Traefik), `2` behind a CDN plus a reverse proxy. The rate limiter keys on the entry that many hops from the right. Firewall the origin so clients can only reach it through those proxies, otherwise they can forge the header and get a fresh rate-limit bucket on every request. With `TRUST_PROXY=0` all callers share one bucket, and the app logs a warning at boot.
- **Monitoring.** `GET /api/health` checks the app; `GET /api/health?deep=1` also pings the CAD worker. Both return 503 when a check fails.

### Cloudflare

`TRUST_CF_CONNECTING_IP=1` keys the rate limiter on `CF-Connecting-IP`, falling back to `TRUST_PROXY` when the header is absent. Enable it only when the origin is firewalled to [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) or uses Authenticated Origin Pulls: anyone who reaches the origin directly can forge that header.

## Upgrading from a version with accounts

Postgres is no longer used. `setup.sh` runs `docker compose up -d --build --wait --remove-orphans`, which stops the old `postgres` container, but its data volume stays until you remove it by hand, after a backup if you want the old account data.

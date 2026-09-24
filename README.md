# Overhang

[![Tests](https://github.com/flowful-ai/overhang/actions/workflows/test.yml/badge.svg)](https://github.com/flowful-ai/overhang/actions/workflows/test.yml)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE)

**Enclosures and brackets, designed by chat.**

Describe the part you need and get a print-ready STL or 3MF in under a minute. Self-hosted, source-available, no account. Built by [Flowful.ai](https://flowful.ai).

![Demo](demo.gif)

- **Conversational CAD**: describe a part in plain English, refine it by chat, or snapshot the viewer and point at what to change.
- **Self-correcting agent**: the model runs its CadQuery code, reads the render result and print review, and fixes its own mistakes.
- **Live 3D preview** on a 256×256 mm build plate. Keys: `R`/`F` reset camera, `W` wireframe, `G` grid.
- **Editable code**: the generated CadQuery Python is shown in an editor; edit and re-render.
- **Print review**: watertight, overhang and thin-wall checks before download. Export STL or 3MF.

**Stack:** Next.js 16 · React 19 · Vercel AI SDK · assistant-ui · React Three Fiber · Monaco · Tailwind v4 · FastAPI · CadQuery · OpenRouter

## Quick start

You need Docker and an [OpenRouter API key](https://openrouter.ai/keys).

```bash
git clone https://github.com/flowful-ai/overhang && cd overhang && ./setup.sh
```

`setup.sh` asks for your OpenRouter key, generates `WORKER_SECRET`, writes `.env` and starts everything with Docker Compose in the background. Open http://localhost:3000. Follow the logs with `docker compose logs -f`; stop with `docker compose down`.

## Models

Overhang talks to OpenRouter only. The model list is `MODELS` in `src/lib/utils.ts`, and the first entry is the default: GPT-5.6 Luna, Sonnet 5, Gemini 3 Flash (best eval pass rate) and DeepSeek V4 Flash (cheapest, about $0.002 per design). Eval results are in `docs/evals/`; Luna has not been evaluated yet.

Web search for product specs is on by default for GPT-5.6 Luna and billed per query. Set `WEB_SEARCH=off` to disable it ([details](docs/configuration.md#web-search)).

## How it works

```
+----------+    prompt     +-------------+   tool: runCadquery(code)   +-------------+
|   You    | ------------> |     LLM     | --------------------------> |  CadQuery   |
|          | <------------ |  (agentic)  | <-------------------------- |   worker    |
+----------+    stream     +-------------+   {success, warnings, stl}  +-------------+
```

The LLM holds a `runCadquery` tool and decides when to call it, fix and stop. A turn is capped at 5 steps, and tools are disabled on the last one, so a turn always ends with a text reply. Printability warnings go both to the model and to you, as a card in the chat.

| Goal | Prompt |
|------|--------|
| Enclosure | "Box for a Pi 5, USB-C cutout, 3mm wall" |
| Bracket | "L-bracket, 60×40mm, 3 holes for M3 screws" |
| Adapter | "GoPro 1/4-20 tripod adapter" |
| Mechanical | "Spur gear, module 1.5, 20 teeth, 5mm bore" |
| Cable management | "Cable clip for a 6mm bundle" |

Start simple and iterate, include dimensions, and mention the material (PLA, PETG, TPU, ABS) for adjusted tolerances. Complex organic shapes are hard: CadQuery is parametric CAD.

## Architecture

- **Next.js app** (`src/`): chat UI, 3D viewer, code editor and API routes. `generate-cad` runs the agent loop, `render-cad` and `export-3mf` call the worker, `health` covers monitoring.
- **CAD worker** (`cad-worker/`): FastAPI and CadQuery. Runs the generated script in a restricted sandbox inside its container, checks the mesh, and exports STL and 3MF.
- **No database, no accounts**: chats stay in the browser's localStorage.

## Configuration

`setup.sh` fills in the two required values, `OPENROUTER_API_KEY` and `WORKER_SECRET`. The ones you are most likely to change:

| Variable | Default | Description |
|----------|---------|-------------|
| `TRUST_PROXY` | `0` | Number of trusted reverse proxies in front of the app. |
| `FRONTEND_BIND` | `127.0.0.1` | Host interface port 3000 is published on. |
| `WEB_SEARCH` | on | `off` disables agent web search for everyone. |
| `EMERGENCY_DISABLE_GENERATION` | unset | `1` makes generation return 503. |

All variables are in [docs/configuration.md](docs/configuration.md).

## Security

There is no sign-in: anyone who can reach the app generates designs on your OpenRouter key. Compose publishes it on loopback by default; add access control before exposing it.

The worker runs LLM-generated Python. Its restricted `exec()` is defence in depth, not a security boundary; the real boundary is the container (non-root, all capabilities dropped, read-only root filesystem, CPU and memory limits, no published port). Its network egress is not blocked. Rate limits, input caps and other protections are listed in [SECURITY.md](SECURITY.md), which is also where to report a vulnerability.

## Running behind a proxy

A local install needs none of this. On a server, put access control in front of the app, set `TRUST_PROXY` to the number of proxies that append to `X-Forwarded-For` (`1` behind nginx, Caddy or Traefik), and firewall the origin so clients cannot bypass them. Cloudflare, port binding and health checks are covered in [docs/configuration.md](docs/configuration.md#running-behind-a-proxy).

## Testing

```bash
npm test    # vitest, includes a free replay of recorded eval fixtures
```

Type check, lint, CAD worker tests and paid live evals are in [CONTRIBUTING.md](CONTRIBUTING.md#tests).

## License

Overhang is under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**: free to use, modify, and self-host for any noncommercial purpose. Commercial use is not permitted without permission; contact hello@flowful.ai. Contributions are welcome and are accepted under the same license (see [CONTRIBUTING.md](CONTRIBUTING.md)).

Built by **[Flowful.ai](https://flowful.ai)**, where we build production AI agents like this one.

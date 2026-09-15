# Contributing

Contributions are welcome. Overhang is under the [PolyForm Noncommercial License 1.0.0](LICENSE), and contributions are accepted under the same license as the project. Commercial use is not permitted without permission; contact hello@flowful.ai.

## Setup

You need Docker and Node.js 24. `./setup.sh` writes `.env` and starts the app on http://localhost:3000.

## Tests

Frontend (Node):

```bash
npm ci
npx tsc --noEmit   # type check
npm run lint       # eslint
npm test           # vitest, includes the free eval fixture replay
```

CAD worker tests (Docker). Test deps are not baked into the image, so they are installed into the container's tmpfs; `WORKER_SECRET` is unset because the suite exercises the unauthenticated API:

```bash
docker compose run --rm -e WORKER_SECRET= cad-worker \
  sh -c "pip install -q --target /tmp/dev -r requirements-dev.txt && PYTHONPATH=/tmp/dev python -m pytest"
```

Tests live in `src/__tests__/` (vitest) and `cad-worker/test_main.py` (pytest). `evals/replay.test.ts` replays recorded fixtures (`evals/fixtures/`) through the real agent core with a mock model, for free; it checks the harness and scoring, not model behavior.

CAD worker lint, on the host with [uv](https://docs.astral.sh/uv/) (or `pipx run --spec ruff==0.15.20 ruff check cad-worker`). Use the ruff version pinned in `cad-worker/requirements-dev.txt`:

```bash
uvx ruff@0.15.20 check cad-worker
```

`npm run eval` calls OpenRouter against a running worker and costs real tokens. It is not needed for a PR. See `evals/run.ts` for `--model`, `--case` and `--record`. Its default model (`DEFAULT_MODEL`, currently the cheapest) differs from the app default, so pass `--model` to evaluate that one.

CI runs all of the above except the paid evals on every pull request.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with an optional scope such as `fix(worker):`.
- Keep each PR to one change, and add or update tests for behavior you change.
- Explain what changed and why in the PR description.
- Report security issues privately, see [SECURITY.md](SECURITY.md).

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

CAD worker tests (Docker):

```bash
docker compose run --rm -e WORKER_SECRET= cad-worker \
  sh -c "pip install -q --target /tmp/dev -r requirements-dev.txt && PYTHONPATH=/tmp/dev python -m pytest"
```

CAD worker lint, on the host with [uv](https://docs.astral.sh/uv/) (or `pipx run --spec ruff==0.15.20 ruff check cad-worker`). Use the ruff version pinned in `cad-worker/requirements-dev.txt`:

```bash
uvx ruff@0.15.20 check cad-worker
```

`npm run eval` calls OpenRouter and costs real tokens. It is not needed for a PR.

CI runs all of the above on every pull request.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with an optional scope such as `fix(worker):`.
- Keep each PR to one change, and add or update tests for behavior you change.
- Explain what changed and why in the PR description.
- Report security issues privately, see [SECURITY.md](SECURITY.md).

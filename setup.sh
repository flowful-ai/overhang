#!/usr/bin/env bash
# Overhang one-shot setup: writes .env (asking only for what it can't generate)
# and starts the app with Docker. Safe to re-run; it never overwrites values
# you've already set.
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

# Update KEY=VALUE in .env, or append it if the key is absent. Uses awk (not
# sed -i, which differs between macOS and GNU) and preserves values that
# contain '=' such as base64 secrets.
set_env() {
  local key="$1" val="$2" tmp
  if grep -qE "^${key}=" .env; then
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$val" 'BEGIN{FS="="} $1==k{print k"="v; next} {print}' .env >"$tmp"
    mv "$tmp" .env
  else
    printf '%s=%s\n' "$key" "$val" >>.env
  fi
}

value_of() { grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2-; }

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required (ships with macOS and most Linux)."; exit 1; }

bold "Overhang setup"
[ -f .env ] || cp .env.example .env

# The one value only you can provide.
if [ -z "$(value_of OPENROUTER_API_KEY)" ]; then
  echo
  dim "Overhang needs a free OpenRouter API key (https://openrouter.ai/keys)."
  if [ -t 0 ]; then
    printf 'Paste your OPENROUTER_API_KEY: '
    read -rs OPENROUTER_KEY
    echo
    [ -n "$OPENROUTER_KEY" ] && set_env OPENROUTER_API_KEY "$OPENROUTER_KEY"
  else
    echo "Run ./setup.sh in a terminal, or set OPENROUTER_API_KEY in .env by hand."
    exit 1
  fi
fi

# The secret docker compose refuses to start without. Generated, never prompted.
[ -z "$(value_of WORKER_SECRET)" ] && set_env WORKER_SECRET "$(openssl rand -hex 32)"

echo
bold ".env is ready."

echo
if [ -t 0 ]; then
  printf 'Start Overhang now with Docker? [Y/n] '
  read -r REPLY
else
  REPLY="y"
fi
case "${REPLY:-y}" in
  [nN]*) echo "Skipped. Start it any time with: docker compose up -d --build --remove-orphans"; exit 0 ;;
esac

# --wait needs Docker Compose v2.1.1 or later. Checked up front, because an
# older Compose fails on the unknown flag with no hint.
if ! docker compose up --help 2>/dev/null | grep -- '--wait' >/dev/null; then
  echo "Docker Compose v2.1.1 or later is required (found: $(docker compose version 2>/dev/null || echo none))."
  echo "Update Docker (https://docs.docker.com/compose/install/), then re-run ./setup.sh."
  exit 1
fi

bold "Starting Overhang (first build takes a few minutes)..."
# Detached (-d), so closing the terminal or Ctrl-C over SSH doesn't stop the
# stack; --wait returns once the services are healthy (or fails if they aren't).
# --remove-orphans stops containers for services no longer in docker-compose.yml
# (the postgres service older installs ran). It never removes volumes.
docker compose up -d --build --wait --remove-orphans || {
  echo
  echo "Startup failed. See what went wrong with: docker compose logs"
  exit 1
}

echo
bold "Overhang is running: http://localhost:3000"
dim "Follow the logs with: docker compose logs -f"
dim "Stop it with:         docker compose down"

#!/usr/bin/env bash
set -euo pipefail
arena_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$arena_root"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$arena_root/.wrangler/cloud-config}"
export WRANGLER_SEND_METRICS=false
exec npm run dev:cloudflare -- --local --ip "${ARENA_HOST:-127.0.0.1}" --port "${ARENA_PORT:-8787}" --show-interactive-dev-session false "$@"

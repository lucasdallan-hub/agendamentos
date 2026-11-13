#!/usr/bin/env bash
set -euo pipefail
arena_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$arena_root"
node --input-type=module -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<24||(major===24&&minor<5))throw new Error("Use Node.js 24.5+; a versão testada está em .node-version.");'
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$arena_root/.wrangler/cloud-config}"
export WRANGLER_SEND_METRICS=false
npm ci --cache "${ARENA_NPM_CACHE:-/tmp/agendamentos-npm-cache}" --no-audit --no-fund
npm run build

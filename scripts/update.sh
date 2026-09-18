#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/update.sh (updates current branch from origin; stop factory first)'
  exit 0
fi
(($# == 0)) || { echo 'Unexpected arguments; see --help.' >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'
exec node scripts/update.mjs

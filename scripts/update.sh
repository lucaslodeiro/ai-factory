#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
configure_defaults=false
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/update.sh [--defaults] (updates current branch, then configures; stop factory first)'
  exit 0
fi
if [[ ${1:-} == --defaults ]]; then
  configure_defaults=true
  shift
fi
(($# == 0)) || { echo 'Unexpected arguments; see --help.' >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'
node scripts/update.mjs
if "$configure_defaults"; then bash scripts/configure.sh --defaults; else bash scripts/configure.sh; fi
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then bash scripts/services.sh install all; fi

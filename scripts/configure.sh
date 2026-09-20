#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ $argument == -h || $argument == --help ]]; then
    echo 'Usage: ai-factory configure [--defaults]'
    echo 'Run `ai-factory help` for every command.'
    exit 0
  fi
done
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'
exec node scripts/configure.mjs "$@"

#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
configure_defaults=false
restart_services=false
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/update.sh [--defaults] [--restart-services]'
  echo '  --defaults          keep the current configuration without prompting'
  echo '  --restart-services  stop loaded services, update, then restore them'
  exit 0
fi
while (($#)); do
  case $1 in
    --defaults) configure_defaults=true;;
    --restart-services) restart_services=true;;
    *) echo 'Unexpected arguments; see --help.' >&2; exit 1;;
  esac
  shift
done
(($# == 0)) || { echo 'Unexpected arguments; see --help.' >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'

restore_daemon=false
restore_dashboard=false
if "$restart_services" && [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  for service in daemon dashboard; do
    if bash scripts/services.sh status "$service" 2>/dev/null | grep -q "^$service: loaded"; then
      if [[ $service == daemon ]]; then restore_daemon=true; else restore_dashboard=true; fi
    fi
  done
  bash scripts/services.sh stop all
fi

node scripts/update.mjs
if "$configure_defaults"; then bash scripts/configure.sh --defaults; else bash scripts/configure.sh; fi
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install all
  if "$restart_services"; then
    if "$restore_daemon"; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start daemon; fi
    if "$restore_dashboard"; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard; fi
  fi
  node scripts/service-summary.mjs
fi

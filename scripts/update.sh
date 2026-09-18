#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
restart_services=false
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/update.sh [--restart-services]'
  echo '  Configuration is preserved and remains editable in the dashboard.'
  echo '  --defaults is accepted as a deprecated no-op.'
  echo '  --restart-services  stop loaded services, update, then restore them'
  exit 0
fi
while (($#)); do
  case $1 in
    --defaults) ;;
    --restart-services) restart_services=true;;
    *) echo 'Unexpected arguments; see --help.' >&2; exit 1;;
  esac
  shift
done
(($# == 0)) || { echo 'Unexpected arguments; see --help.' >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'

update_complete=false
restore_daemon=false
restore_dashboard=false
services_stopped=false
write_update_state() {
  [[ -n ${AI_FACTORY_UPDATE_STATE_FILE:-} ]] || return 0
  node -e 'const fs=require("fs"),path=require("path");const [file,status,phase,pid]=process.argv.slice(1);let old={};try{old=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}const now=new Date().toISOString();const next={...old,status,phase,pid:Number(pid),startedAt:old.startedAt||now};if(status!=="updating")next.finishedAt=now;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+".tmp",JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(file+".tmp",file);' "$AI_FACTORY_UPDATE_STATE_FILE" "$1" "$2" "$$"
}
finish_update() {
  if "$update_complete"; then
    write_update_state completed "Update completed. Services restored."
  else
    write_update_state failed "Update failed. Inspect .factory/service-logs/update.log."
    if "$services_stopped" && "$restore_dashboard"; then
      set +e
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install dashboard
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard
    fi
  fi
}
trap finish_update EXIT
write_update_state updating "Stopping services…"

if "$restart_services" && [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  for service in daemon dashboard; do
    if bash scripts/services.sh status "$service" 2>/dev/null | grep -q "^$service: loaded"; then
      if [[ $service == daemon ]]; then restore_daemon=true; else restore_dashboard=true; fi
    fi
  done
  bash scripts/services.sh stop all
  services_stopped=true
fi

write_update_state updating "Downloading, building and validating…"
node scripts/update.mjs
write_update_state updating "Preserving configuration…"
if [[ ! -f .env ]]; then umask 077; cp .env.example .env; fi
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  write_update_state updating "Installing and restarting services…"
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install all
  if "$restart_services"; then
    if "$restore_daemon"; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start daemon; fi
    if "$restore_dashboard"; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard; fi
  fi
  node scripts/service-summary.mjs
fi
update_complete=true

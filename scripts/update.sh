#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
restart_services=false
start_services=false
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/update.sh [--restart-services|--start-services]'
  echo '  Configuration is preserved and remains editable in the dashboard.'
  echo '  --defaults is accepted as a deprecated no-op.'
  echo '  --restart-services  stop loaded services, update, then restore them'
  echo '  --start-services    recovery mode: stop services, update, then start both'
  exit 0
fi
while (($#)); do
  case $1 in
    --defaults) ;;
    --restart-services) restart_services=true;;
    --start-services) start_services=true;;
    *) echo 'Unexpected arguments; see --help.' >&2; exit 1;;
  esac
  shift
done
(($# == 0)) || { echo 'Unexpected arguments; see --help.' >&2; exit 1; }
! "$restart_services" || ! "$start_services" || { echo 'Choose either --restart-services or --start-services.' >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'

update_complete=false
restore_daemon=false
restore_dashboard=false
restore_intent_known=false
if [[ -n ${AI_FACTORY_UPDATE_STATE_FILE:-} && -f $AI_FACTORY_UPDATE_STATE_FILE ]]; then
  IFS=' ' read -r restore_intent_known restore_daemon restore_dashboard < <(node -e 'const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}const known=typeof s.restoreDaemon==="boolean"&&typeof s.restoreDashboard==="boolean";console.log(`${known} ${known&&s.restoreDaemon} ${known&&s.restoreDashboard}`)' "$AI_FACTORY_UPDATE_STATE_FILE")
fi
write_update_state() {
  [[ -n ${AI_FACTORY_UPDATE_STATE_FILE:-} ]] || return 0
  node -e 'const fs=require("fs"),path=require("path");const [file,status,phase,pid]=process.argv.slice(1);let old={};try{old=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}const now=new Date().toISOString();const next={...old,status,phase,pid:Number(pid),startedAt:old.startedAt||now,updatedAt:now};if(status!=="updating")next.finishedAt=now;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+".tmp",JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(file+".tmp",file);' "$AI_FACTORY_UPDATE_STATE_FILE" "$1" "$2" "$$"
}
finish_update() {
  if "$update_complete"; then
    write_update_state completed "Update completed. Services restored."
  else
    if [[ -z ${AI_FACTORY_UPDATE_STATE_FILE:-} ]] || ! node -e 'const fs=require("fs");try{process.exit(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).status==="failed"?0:1)}catch{process.exit(1)}' "$AI_FACTORY_UPDATE_STATE_FILE"; then
      write_update_state failed "Update failed. Inspect .factory/service-logs/update.log."
    fi
    # A failed update must not change the operator's service state. Reinstall
    # launchd definitions in case the checkout changed before the failure, then
    # restore every service that was loaded when this update began.
    set +e
    if "$restore_daemon"; then
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install daemon
      if ! bash scripts/services.sh status daemon 2>/dev/null | grep -q '^daemon: loaded'; then
        AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start daemon
      fi
    fi
    if "$restore_dashboard" && ! bash scripts/services.sh status dashboard 2>/dev/null | grep -q '^dashboard: loaded'; then
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install dashboard
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard
    fi
  fi
}
trap finish_update EXIT
write_update_state updating "Stopping daemon; dashboard remains available…"

if ( "$restart_services" || "$start_services" ) && [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  if "$start_services"; then
    restore_daemon=true
    restore_dashboard=true
  elif ! "$restore_intent_known"; then
    for service in daemon dashboard; do
      if bash scripts/services.sh status "$service" 2>/dev/null | grep -q "^$service: loaded"; then
        if [[ $service == daemon ]]; then restore_daemon=true; else restore_dashboard=true; fi
      fi
    done
  fi
  bash scripts/services.sh stop daemon
  # launchctl can return before the daemon finishes its graceful shutdown and
  # releases the SQLite lock. Tell update.mjs to wait for that specific case;
  # direct updates against an independently running daemon still fail fast.
  if "$restore_daemon"; then export AI_FACTORY_WAIT_FOR_DAEMON_STOP=1; fi
fi

write_update_state updating "Downloading, building and validating…"
node scripts/update.mjs
write_update_state updating "Preserving configuration…"
if [[ ! -f .env ]]; then umask 077; cp .env.example .env; fi
mkdir -p "$HOME/.local/bin"
launcher="$HOME/.local/bin/ai-factory"
if [[ ! -e $launcher || -L $launcher ]]; then
  ln -sfn "$PWD/scripts/ai-factory" "$launcher"
else
  echo "Launcher not replaced because a regular file already exists: $launcher" >&2
fi
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  write_update_state updating "Installing and restarting services…"
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install all
  if "$restart_services" || "$start_services"; then
    if "$restore_daemon"; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start daemon; fi
    if "$restore_dashboard" && ! bash scripts/services.sh status dashboard 2>/dev/null | grep -q '^dashboard: loaded'; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard; fi
  fi
  node scripts/service-summary.mjs
fi
update_complete=true

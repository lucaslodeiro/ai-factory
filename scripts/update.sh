#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
restart_services=false
start_services=false
finish_phase=false
for argument in "$@"; do
if [[ $argument == -h || $argument == --help ]]; then
  echo 'Usage: bash scripts/update.sh [--restart-services|--start-services]'
  echo '  Configuration is preserved and remains editable in the dashboard.'
  echo '  --restart-services  stop loaded services, update, then restore them'
  echo '  --start-services    recovery mode: stop services, update, then start both'
  echo '  --finish-update     internal: run only the steps after the new version is activated'
  echo 'Run `ai-factory help` for every command.'
  exit 0
fi
done
while (($#)); do
  case $1 in
    --restart-services) restart_services=true;;
    --start-services) start_services=true;;
    --finish-update) finish_phase=true;;
    *) echo 'Unexpected arguments; see --help.' >&2; exit 1;;
  esac
  shift
done
(($# == 0)) || { echo 'Unexpected arguments; see --help.' >&2; exit 1; }
! "$restart_services" || ! "$start_services" || { echo 'Choose either --restart-services or --start-services.' >&2; exit 1; }
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
engine=$PWD
home=${AI_FACTORY_HOME:-$engine}
[[ ${engine##*/} != engine || -n ${AI_FACTORY_HOME:-} ]] || home=${engine%/engine}
export AI_FACTORY_HOME="$home"
export AI_FACTORY_UPDATE_STATE_FILE="${AI_FACTORY_UPDATE_STATE_FILE:-$home/data/update-state.json}"
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22+ is required"); process.exit(1); }'

# `cmd | grep -q` is unsafe under `set -o pipefail`. grep exits at its first match and the producer
# then writes into a pipe with no reader, dies of SIGPIPE and reports 141, so the pipeline fails
# even though the pattern matched. services.sh prints the service line, forks awk, then prints
# more, which loses that race almost every time: a daemon that IS loaded read as stopped and was
# left down after an update. Capture the report and match it in the shell, with no pipeline at all.
service_loaded() {
  local service=$1 report
  report=$(bash scripts/services.sh status "$service" 2>/dev/null || true)
  [[ $'\n'$report == *$'\n'"$service: loaded"* ]]
}

update_complete=false
restore_daemon=false
restore_dashboard=false
restore_intent_known=false
if [[ -n ${AI_FACTORY_UPDATE_STATE_FILE:-} && -f $AI_FACTORY_UPDATE_STATE_FILE ]]; then
  IFS=' ' read -r restore_intent_known restore_daemon restore_dashboard < <(node -e 'const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}const known=s.status==="updating"&&typeof s.restoreDaemon==="boolean"&&typeof s.restoreDashboard==="boolean";console.log(`${known} ${known&&s.restoreDaemon} ${known&&s.restoreDashboard}`)' "$AI_FACTORY_UPDATE_STATE_FILE")
fi
write_update_state() {
  [[ -n ${AI_FACTORY_UPDATE_STATE_FILE:-} ]] || return 0
  node -e 'const fs=require("fs"),path=require("path");const [file,status,phase,pid,restoreDaemon,restoreDashboard]=process.argv.slice(1);let old={};try{old=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}const now=new Date().toISOString(),continuing=old.status==="updating",next={...(continuing?old:{}),status,phase,pid:Number(pid),startedAt:continuing&&old.startedAt||now,updatedAt:now};if(restoreDaemon==="true"||restoreDaemon==="false")next.restoreDaemon=restoreDaemon==="true";if(restoreDashboard==="true"||restoreDashboard==="false")next.restoreDashboard=restoreDashboard==="true";if(phase.startsWith("Stopping daemon"))next.versionActivated=false;if(status!=="updating")next.finishedAt=now;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+".tmp",JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(file+".tmp",file);' "$AI_FACTORY_UPDATE_STATE_FILE" "$1" "$2" "$$" "${3:-}" "${4:-}"
}
finish_update() {
  if "$update_complete"; then
    write_update_state completed "Update completed. Services restored."
  else
    if [[ -z ${AI_FACTORY_UPDATE_STATE_FILE:-} ]] || ! node -e 'const fs=require("fs");try{process.exit(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).status==="failed"?0:1)}catch{process.exit(1)}' "$AI_FACTORY_UPDATE_STATE_FILE"; then
      write_update_state failed "Update failed. Inspect data/service-logs/update.log."
    fi
    # Preparation failures leave the old version intact. An activation/service
    # failure must not restart the new daemon repeatedly as if recovery succeeded.
    if [[ -n ${AI_FACTORY_UPDATE_STATE_FILE:-} ]] && node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).versionActivated===true?0:1)}catch{process.exit(1)}' "$AI_FACTORY_UPDATE_STATE_FILE"; then
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh stop daemon || true
      echo "The new version was activated but service recovery failed. Daemon left stopped; inspect the update log and backup." >&2
      return
    fi
    set +e
    if "$restore_daemon"; then
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install daemon
      if ! service_loaded daemon; then
        AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start daemon
      fi
    fi
    if "$restore_dashboard" && ! service_loaded dashboard; then
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install dashboard
      AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard
    fi
  fi
}
trap finish_update EXIT
# The finish phase inherits an update already in flight; re-announcing this phase would also clear
# the versionActivated flag the recovery path depends on.
"$finish_phase" || write_update_state updating "Stopping daemon; dashboard remains available…"

if ! "$finish_phase"; then
if ( "$restart_services" || "$start_services" ) && [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  if "$start_services"; then
    restore_daemon=true
    restore_dashboard=true
  elif ! "$restore_intent_known"; then
    for service in daemon dashboard; do
      if service_loaded "$service"; then
        if [[ $service == daemon ]]; then restore_daemon=true; else restore_dashboard=true; fi
      fi
    done
  fi
  write_update_state updating "Stopping daemon; dashboard remains available…" "$restore_daemon" "$restore_dashboard"
  bash scripts/services.sh stop daemon
  # launchctl can return before the daemon finishes its graceful shutdown and
  # releases the SQLite lock. Tell update.mjs to wait for that specific case;
  # direct updates against an independently running daemon still fail fast.
  if "$restore_daemon"; then export AI_FACTORY_WAIT_FOR_DAEMON_STOP=1; fi
fi

write_update_state updating "Downloading, building and validating…"
node scripts/update.mjs
# Everything below belongs to the version that was just activated, so hand over to its own updater.
# Otherwise a fix to those steps only takes effect one update later, which is what left the daemon
# stopped after three updates in a row: each of them was still running the previous script. The
# restore intent travels in the state file, which the new process reads on startup.
mode=""
"$restart_services" && mode=--restart-services || true
"$start_services" && mode=--start-services || true
# Unquoted on purpose: $mode is one of two fixed flags or empty, and bash 3.2 under `set -u`
# rejects the empty-array expansion that would otherwise express this.
exec bash scripts/update.sh --finish-update $mode
fi

write_update_state updating "Preserving configuration…"
if [[ ! -f "$home/.env" ]]; then umask 077; cp .env.example "$home/.env"; fi
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
    if "$restore_dashboard" && ! service_loaded dashboard; then AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard; fi
  fi
  for service in daemon dashboard; do
    if ! service_loaded "$service"; then
      echo "The $service is not running after this update. Start it with: ai-factory service start $service" >&2
    fi
  done
  node scripts/service-summary.mjs
fi
mkdir -p "$home/data"
node -e 'const fs=require("fs"),cp=require("child_process"),manifest=require("./package.json");const run=args=>cp.execFileSync("git",args,{encoding:"utf8"}).trim();const marker={version:manifest.version,branch:run(["symbolic-ref","--quiet","--short","HEAD"]),revision:run(["rev-parse","HEAD"]),installedAt:new Date().toISOString()};fs.writeFileSync(process.env.AI_FACTORY_HOME+"/data/install.json",JSON.stringify(marker,null,2)+"\n",{mode:0o600});'
update_complete=true

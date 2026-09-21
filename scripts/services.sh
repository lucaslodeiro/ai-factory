#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
home=${AI_FACTORY_HOME:-$root}
[[ ${root##*/} != engine || -n ${AI_FACTORY_HOME:-} ]] || home=${root%/engine}
export AI_FACTORY_HOME="$home"
agents="$HOME/Library/LaunchAgents"
logs="$home/data/service-logs"
domain="gui/$UID"
service_wait_attempts=${AI_FACTORY_SERVICE_WAIT_ATTEMPTS:-}

usage() {
  cat <<'EOF'
Usage:
  ai-factory service <install|start|stop|restart|status|logs> <daemon|dashboard|all>
  ai-factory uninstall [--purge] [--yes] [--force]

From a developer checkout:
  npm run service -- <install|start|stop|restart|status|logs> <daemon|dashboard|all>
  npm run uninstall -- [--purge] [--yes] [--force]

Basic uninstall removes services, engine and runtime data while preserving configuration and repos/. Use --purge to remove the complete factory home.
Run `ai-factory help` for every command.
EOF
}
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
label() { printf 'com.ai-factory.%s' "$1"; }
plist() { printf '%s/%s.plist' "$agents" "$(label "$1")"; }
loaded() { launchctl print "$domain/$(label "$1")" >/dev/null 2>&1; }
configured_value() {
  local key=$1 file="$home/.env"
  [[ -f $file ]] || return
  awk -F= -v key="$key" '$1==key{sub(/^[^=]*=/,"");gsub(/^[[:space:]]+|[[:space:]]+$/,"");print;exit}' "$file"
}
daemon_configuration_ready() {
  local repository approvers repo_dir
  repository=$(configured_value GITHUB_REPOSITORY)
  approvers=$(configured_value FACTORY_APPROVERS)
  repo_dir=$(configured_value FACTORY_REPO_DIR)
  [[ $repository =~ ^[^/]+/[^/]+$ && $approvers =~ [[:alnum:]_.-] && $repo_dir =~ [^[:space:]] ]]
}
wait_for_service() {
  local service=$1 expected_pid lock_pid details attempt attempts=${service_wait_attempts:-40}
  [[ $service == daemon ]] && attempts=${service_wait_attempts:-300}
  for ((attempt=0; attempt<attempts; attempt++)); do
    details=$(launchctl print "$domain/$(label "$service")" 2>/dev/null || true)
    expected_pid=$(awk '/pid =/{print $3;exit}' <<<"$details")
    if [[ $service == dashboard && -n $expected_pid ]]; then return 0; fi
    lock_pid=$(cat "$home/data/daemon.lock" 2>/dev/null || true)
    if [[ -n $expected_pid && $expected_pid == "$lock_pid" ]]; then return 0; fi
    sleep 0.25
  done
  launchctl bootout "$domain/$(label "$service")" >/dev/null 2>&1 || true
  echo "${service^} did not become ready and was stopped. Inspect: $logs/$service.error.log" >&2
  return 1
}

write_service() {
  local service=$1 command node_path runtime_path file service_label
  command=start
  [[ $service == dashboard ]] && command=dashboard
  node_path=$(command -v node)
  runtime_path="$(dirname "$node_path"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  file=$(plist "$service")
  service_label=$(label "$service")
  mkdir -p "$agents" "$logs"
  cat > "$file.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$(xml "$service_label")</string>
  <key>ProgramArguments</key><array><string>$(xml "$node_path")</string><string>$(xml "$root/dist/src/cli.js")</string><string>$command</string></array>
  <key>WorkingDirectory</key><string>$(xml "$root")</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$(xml "$HOME")</string><key>PATH</key><string>$(xml "$runtime_path")</string><key>AI_FACTORY_HOME</key><string>$(xml "$home")</string><key>FACTORY_MANAGED_SERVICE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$logs/$service.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$logs/$service.error.log")</string>
</dict></plist>
EOF
  chmod 600 "$file.tmp"
  mv "$file.tmp" "$file"
  plutil -lint "$file" >/dev/null
  echo "Installed $service service: $file"
}

install_one() {
  local service=$1 was_loaded=false
  if loaded "$service"; then was_loaded=true; stop_one "$service"; fi
  write_service "$service"
  if "$was_loaded"; then
    if [[ $service == daemon ]] && ! daemon_configuration_ready; then
      echo "Installed daemon service; it remains stopped until configuration is complete."
      return
    fi
    launchctl bootstrap "$domain" "$(plist "$service")"
    wait_for_service "$service"
  fi
}
start_one() {
  local service=$1
  if [[ $service == daemon ]] && ! daemon_configuration_ready; then
    if loaded daemon; then launchctl bootout "$domain/$(label daemon)" >/dev/null 2>&1 || true; fi
    echo "Daemon was not started: configure GITHUB_REPOSITORY, FACTORY_APPROVERS and FACTORY_REPO_DIR first." >&2
    return 1
  fi
  [[ -f $(plist "$service") ]] || write_service "$service"
  if loaded "$service"; then launchctl kickstart -k "$domain/$(label "$service")"; else launchctl bootstrap "$domain" "$(plist "$service")"; fi
  wait_for_service "$service"
  echo "Started $service"
}
stop_one() {
  local service=$1 attempt attempts=${service_wait_attempts:-60}
  if ! loaded "$service"; then echo "$service is already stopped"; return; fi
  launchctl bootout "$domain/$(label "$service")" >/dev/null 2>&1 || true
  for ((attempt=0; attempt<attempts; attempt++)); do
    if ! loaded "$service"; then echo "Stopped $service"; return; fi
    sleep 0.25
  done
  echo "Could not stop $service; launchd still reports it as loaded." >&2
  return 1
}
status_one() {
  local service=$1 details pid lock_pid readiness="not ready"
  if ! loaded "$service"; then echo "$service: stopped"; return; fi
  details=$(launchctl print "$domain/$(label "$service")")
  pid=$(awk '/pid =/{print $3;exit}' <<<"$details")
  if [[ $service == dashboard && -n $pid ]]; then readiness=ready; fi
  if [[ $service == daemon ]]; then lock_pid=$(cat "$home/data/daemon.lock" 2>/dev/null || true);[[ -n $pid && $pid == "$lock_pid" ]] && readiness=ready;fi
  echo "$service: loaded"
  awk '/state =|pid =|last exit code =/{sub(/^[[:space:]]*/,"  ");print}' <<<"$details"
  echo "  readiness = $readiness"
}
logs_for() {
  local service=$1
  mkdir -p "$logs"
  if [[ $service == all ]]; then
    touch "$logs/daemon.log" "$logs/daemon.error.log" "$logs/dashboard.log" "$logs/dashboard.error.log"
    exec tail -n 100 -F "$logs/daemon.log" "$logs/daemon.error.log" "$logs/dashboard.log" "$logs/dashboard.error.log"
  fi
  touch "$logs/$service.log" "$logs/$service.error.log"
  exec tail -n 100 -F "$logs/$service.log" "$logs/$service.error.log"
}

for argument in "$@"; do
  if [[ $argument == help || $argument == -h || $argument == --help ]]; then usage; exit 0; fi
done
case ${1:-} in
  uninstall)
    shift
    exec node "$root/scripts/uninstall.mjs" "$@"
    ;;
esac
[[ $(uname -s) == Darwin ]] || { echo 'Factory services require macOS launchd.' >&2; exit 1; }
action=${1:-}; target=${2:-}
[[ $action =~ ^(install|start|stop|restart|status|logs)$ && $target =~ ^(daemon|dashboard|all)$ && $# == 2 ]] || { usage >&2; exit 1; }
if [[ $action == logs ]]; then logs_for "$target"; fi
services=($target); [[ $target == all ]] && services=(daemon dashboard)
for service in "${services[@]}"; do
  case $action in
    install) install_one "$service";;
    start) start_one "$service";;
    stop) stop_one "$service";;
    restart) stop_one "$service"; start_one "$service";;
    status) status_one "$service";;
  esac
done
if [[ ${AI_FACTORY_HIDE_SERVICE_SUMMARY:-0} != 1 && ( $action == install || $action == start || $action == restart ) ]]; then node scripts/service-summary.mjs; fi

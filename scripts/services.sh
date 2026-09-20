#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agents="$HOME/Library/LaunchAgents"
logs="$root/.factory/service-logs"
domain="gui/$UID"

usage() {
  cat <<'EOF'
Usage:
  npm run service -- <install|start|stop|restart|status|logs> <daemon|dashboard|all>
  npm run service -- uninstall [--yes]

Uninstall removes both services, this factory installation and its runtime data.
Target repositories, shared tools and provider credentials are preserved.
Run `ai-factory help` for every command.
EOF
}
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
label() { printf 'com.ai-factory.%s' "$1"; }
plist() { printf '%s/%s.plist' "$agents" "$(label "$1")"; }
loaded() { launchctl print "$domain/$(label "$1")" >/dev/null 2>&1; }

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
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$(xml "$HOME")</string><key>PATH</key><string>$(xml "$runtime_path")</string></dict>
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
  if loaded "$service"; then was_loaded=true; launchctl bootout "$domain/$(label "$service")"; fi
  write_service "$service"
  if "$was_loaded"; then launchctl bootstrap "$domain" "$(plist "$service")"; fi
}
start_one() {
  local service=$1
  [[ -f $(plist "$service") ]] || write_service "$service"
  if loaded "$service"; then launchctl kickstart -k "$domain/$(label "$service")"; else launchctl bootstrap "$domain" "$(plist "$service")"; fi
  echo "Started $service"
}
stop_one() {
  local service=$1
  if loaded "$service"; then launchctl bootout "$domain/$(label "$service")"; echo "Stopped $service"; else echo "$service is already stopped"; fi
}
status_one() {
  local service=$1
  if loaded "$service"; then echo "$service: loaded"; launchctl print "$domain/$(label "$service")" | awk '/state =|pid =|last exit code =/{sub(/^[[:space:]]*/,"  ");print}'; else echo "$service: stopped"; fi
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
    [[ $# == 0 || ( $# == 1 && $1 == --yes ) ]] || { usage >&2; exit 1; }
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

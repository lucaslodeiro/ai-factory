#!/usr/bin/env bash
set -euo pipefail

# An uninstall can remove the directory inherited by the caller's shell. Tools
# used below call getcwd(), so recover before invoking any of them.
if ! builtin pwd -P >/dev/null 2>&1; then
  cd "$HOME"
fi

repo=https://github.com/lucaslodeiro/ai-factory.git
branch=main
dest="$HOME/ai-factory"
dashboard_host=
dashboard_port=
install_step="validating installer arguments"
cloned_destination=false
report_install_failure() {
  status=$?
  if "$cloned_destination"; then
    backup_destination="${dest}/engine.incomplete-$(date +%Y%m%d-%H%M%S)"
    printf 'Installation failed while %s. The incomplete directory was preserved.\n' "$install_step" >&2
    printf 'Retry with:\n  cd %q\n  mv %q %q\n  bash /tmp/ai-factory-install-macos.sh --dir %q --branch %q --repo %q\n' "$dest" "$dest/engine" "$backup_destination" "$dest" "$branch" "$repo" >&2
  fi
  return "$status"
}
trap report_install_failure ERR
while (($#)); do
  case "$1" in
    --dir|--branch|--repo|--dashboard-host|--dashboard-port)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --dir) dest=$2;; --branch) branch=$2;; --repo) repo=$2;; --dashboard-host) dashboard_host=$2;; --dashboard-port) dashboard_port=$2;; esac
      shift 2;;
    -h|--help) echo 'Internal installer. Run install-macos.sh --help for public options.'; echo 'Run `ai-factory help` for every installed command.'; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done
[[ -z $dashboard_host || $dashboard_host == 127.0.0.1 || $dashboard_host == localhost || $dashboard_host == ::1 ]] || { echo 'Dashboard host must be 127.0.0.1, localhost or ::1.' >&2; exit 1; }
[[ -z $dashboard_port || ( $dashboard_port =~ ^[0-9]+$ && $dashboard_port -ge 1 && $dashboard_port -le 65535 ) ]] || { echo 'Dashboard port must be from 1 to 65535.' >&2; exit 1; }
stop_existing_factory_services() {
  [[ $(uname -s) != Darwin || ${AI_FACTORY_SKIP_SERVICES:-0} == 1 ]] && return
  local domain="gui/$(id -u)" label
  while IFS= read -r label; do
    [[ $label == com.ai-factory.update.* ]] || continue
    launchctl remove "$label" >/dev/null 2>&1 || true
    if launchctl print "$domain/$label" >/dev/null 2>&1; then
      echo "Could not stop existing service: $label" >&2
      exit 1
    fi
  done < <(launchctl list 2>/dev/null | awk '{print $NF}')
  for label in com.ai-factory.daemon com.ai-factory.dashboard; do
    if launchctl print "$domain/$label" >/dev/null 2>&1; then
      echo "Stopping existing ${label##*.} service..."
      launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
      if launchctl print "$domain/$label" >/dev/null 2>&1; then
        echo "Could not stop existing service: $label" >&2
        exit 1
      fi
    fi
  done
}
engine="$dest/engine"
marker="$dest/data/install.json"
if [[ -d $engine && -f $marker ]]; then echo "Destination is already installed: $dest" >&2; exit 1; fi
stop_existing_factory_services
if [[ -e $engine ]]; then echo "An incomplete engine already exists: $engine" >&2; exit 1; fi
if [[ -e $dest ]]; then
  while IFS= read -r entry; do
    name=${entry##*/}
    if [[ $name == .env || $name == .env.backup-* || $name == repos ]]; then
      continue
    fi
    if [[ $name == .uninstall && -d $entry ]]; then continue; fi
    if [[ $name == engine.incomplete-* && -d $entry ]]; then
      continue
    fi
    if [[ $name == data && -d $entry && ! -e $marker ]]; then
      continue
    fi
    echo "An unrelated destination entry already exists: $entry" >&2
    exit 1
  done < <(find "$dest" -mindepth 1 -maxdepth 1 -print)
fi
mkdir -p "$dest"
export AI_FACTORY_HOME="$dest"
export PATH="$HOME/.local/bin:$PATH"
node_ok() { command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; }
node_ok || { echo 'Node 22+ is required.' >&2; exit 1; }
npm --version >/dev/null
git --version >/dev/null
install_step="cloning the factory repository"
GIT_TERMINAL_PROMPT=0 git clone --branch "$branch" -- "$repo" "$engine"
cloned_destination=true
cd "$engine"
install_step="installing npm dependencies"
CI=1 npm ci --no-audit --no-fund
install_step="building the factory"
npm run build
install_step="creating the installation identity"
node -e 'import("./dist/src/instance.js").then(module=>module.readOrCreateInstance())'
install_step="validating the installation"
node scripts/validate-installation.mjs
install_step="installing the launcher"
mkdir -p "$HOME/.local/bin"
launcher="$HOME/.local/bin/ai-factory"
if [[ -e $launcher && ! -L $launcher ]]; then
  echo "Cannot install launcher over existing file: $launcher" >&2
  exit 1
fi
ln -sfn "$engine/scripts/ai-factory" "$launcher"
rm -rf "$dest/.uninstall"
umask 077
install_step="creating the initial configuration"
node scripts/initialize-environment.mjs
dashboard_url=$(node scripts/prepare-dashboard-config.mjs "$dashboard_host" "$dashboard_port")
dashboard_ready=false
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  install_step="installing and starting services"
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install all
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard
  for _ in {1..40}; do
    if node -e 'fetch(process.argv[1]).then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))' "$dashboard_url/healthz"; then dashboard_ready=true; break; fi
    sleep 0.25
  done
  setup_suffix='?setup=1'
  if node -e 'fetch(process.argv[1]+"/api/settings").then(r=>r.json()).then(v=>process.exit(v.readiness?.ready?0:1)).catch(()=>process.exit(1))' "$dashboard_url"; then
    setup_suffix=''
    AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start daemon
  else
    AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh stop daemon
  fi
  if [[ $(uname -s) == Darwin && ${AI_FACTORY_NO_OPEN:-0} != 1 ]]; then
    open "$dashboard_url/$setup_suffix" || printf 'Open this URL to finish setup: %s/%s\n' "$dashboard_url" "$setup_suffix"
  fi
fi

printf '\n============================================================\n'
printf 'AI Factory installation completed successfully\n'
printf '============================================================\n'
printf 'Home:          %s\n' "$dest"
printf 'Engine:        %s\n' "$engine"
printf 'Configuration: continue in the dashboard\n'
printf 'Daemon:        starts automatically after valid first-time setup\n'
if "$dashboard_ready"; then printf 'Dashboard:     running at %s\n' "$dashboard_url"; else printf 'Dashboard:     started; health check pending at %s (see data/service-logs/dashboard.error.log)\n' "$dashboard_url"; fi
printf 'Services:      daemon and dashboard definitions installed\n'
printf 'Launcher:      %s\n' "$HOME/.local/bin/ai-factory"
printf 'Toolchain:     %s (no Homebrew)\n' "$HOME/.local"
cat <<'PATH_NEXT'

Persist the tool path once before opening a new terminal:
  grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.zprofile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zprofile"
  source "$HOME/.zprofile"
PATH_NEXT
cat <<'NEXT'

First-run checklist:
  1. Complete Credentials and Configuration in the dashboard opened by the installer.
  2. Save the target repository, local clone and authorized approvers.
  3. Save and apply. Once all required checks pass, the daemon starts automatically.

Until setup is valid, only the local dashboard runs and no agent can start.
NEXT
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then node scripts/service-summary.mjs; fi
install_step="writing the installation marker"
mkdir -p "$dest/data"
node -e 'const fs=require("fs"),cp=require("child_process"),manifest=require("./package.json");const run=args=>cp.execFileSync("git",args,{encoding:"utf8"}).trim();const marker={version:manifest.version,branch:run(["symbolic-ref","--quiet","--short","HEAD"]),revision:run(["rev-parse","HEAD"]),installedAt:new Date().toISOString()};fs.writeFileSync(process.env.AI_FACTORY_HOME+"/data/install.json",JSON.stringify(marker,null,2)+"\n",{mode:0o600});'

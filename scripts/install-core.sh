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
while (($#)); do
  case "$1" in
    --dir|--branch|--repo|--dashboard-host|--dashboard-port)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --dir) dest=$2;; --branch) branch=$2;; --repo) repo=$2;; --dashboard-host) dashboard_host=$2;; --dashboard-port) dashboard_port=$2;; esac
      shift 2;;
    --help) echo 'Internal usage: bash install-core.sh [--dir PATH] [--branch BRANCH] [--repo URL] [--dashboard-host LOOPBACK] [--dashboard-port PORT]'; echo 'Use install-macos.sh as the public installer. If the selected/default port is occupied, it saves and opens the next available port.'; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done
[[ -z $dashboard_host || $dashboard_host == 127.0.0.1 || $dashboard_host == localhost || $dashboard_host == ::1 ]] || { echo 'Dashboard host must be 127.0.0.1, localhost or ::1.' >&2; exit 1; }
[[ -z $dashboard_port || ( $dashboard_port =~ ^[0-9]+$ && $dashboard_port -ge 1 && $dashboard_port -le 65535 ) ]] || { echo 'Dashboard port must be from 1 to 65535.' >&2; exit 1; }
if [[ -e "$dest" ]]; then
  if [[ -d "$dest/.git" && -f "$dest/package.json" ]]; then
    echo "AI Factory is already installed at $dest" >&2
    echo "Update it with: cd \"$dest\" && bash scripts/update.sh --restart-services" >&2
    echo "For a clean reinstall: cd \"$HOME\" && npm --prefix \"$dest\" run uninstall" >&2
  else
    echo "An incomplete or unrelated destination already exists: $dest" >&2
    backup_destination="${dest}.incomplete-$(date +%Y%m%d-%H%M%S)"
    echo "Preserve it and retry with:" >&2
    echo "  cd \"$HOME\"" >&2
    echo "  mv \"$dest\" \"$backup_destination\"" >&2
    echo "  bash /tmp/ai-factory-install-macos.sh --dir \"$dest\"" >&2
  fi
  exit 1
fi
export PATH="$HOME/.local/bin:$PATH"
node_ok() { command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; }
node_ok || { echo 'Node 22+ is required.' >&2; exit 1; }
npm --version >/dev/null
git --version >/dev/null
GIT_TERMINAL_PROMPT=0 git clone --branch "$branch" -- "$repo" "$dest"
cd "$dest"
CI=1 npm ci --no-audit --no-fund
npm run build
npm test
mkdir -p "$HOME/.local/bin"
launcher="$HOME/.local/bin/ai-factory"
if [[ -e $launcher && ! -L $launcher ]]; then
  echo "Cannot install launcher over existing file: $launcher" >&2
  exit 1
fi
ln -sfn "$dest/scripts/ai-factory" "$launcher"
umask 077
cp .env.example .env
dashboard_url=$(node scripts/prepare-dashboard-config.mjs "$dashboard_host" "$dashboard_port")
dashboard_ready=false
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh install all
  AI_FACTORY_HIDE_SERVICE_SUMMARY=1 bash scripts/services.sh start dashboard
  for _ in {1..40}; do
    if curl -fsS "$dashboard_url/healthz" >/dev/null 2>&1; then dashboard_ready=true; break; fi
    sleep 0.25
  done
  if [[ $(uname -s) == Darwin && ${AI_FACTORY_NO_OPEN:-0} != 1 ]]; then
    open "$dashboard_url/?setup=1" || printf 'Open this URL to finish setup: %s/?setup=1\n' "$dashboard_url"
  fi
fi

printf '\n============================================================\n'
printf 'AI Factory installation completed successfully\n'
printf '============================================================\n'
printf 'Engine:        %s\n' "$PWD"
printf 'Configuration: continue in the dashboard\n'
printf 'Daemon:        starts automatically after valid first-time setup\n'
if "$dashboard_ready"; then printf 'Dashboard:     running at %s\n' "$dashboard_url"; else printf 'Dashboard:     started; health check pending at %s (see .factory/service-logs/dashboard.error.log)\n' "$dashboard_url"; fi
printf 'Services:      daemon and dashboard definitions installed\n'
printf 'Launcher:      %s\n' "$HOME/.local/bin/ai-factory"
if [[ ${AI_FACTORY_INSTALL_MODE:-} == user-local ]]; then
  printf 'Toolchain:     %s (no Homebrew)\n' "$HOME/.local"
  cat <<'PATH_NEXT'

Persist the tool path once before opening a new terminal:
  grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.zprofile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zprofile"
  source "$HOME/.zprofile"
PATH_NEXT
else
  printf 'Tool paths:    %s and %s\n' "$(dirname "$(command -v node)")" "$(dirname "$(command -v git)")"
fi
cat <<'NEXT'

First-run checklist:
  1. Complete Credentials and Configuration in the dashboard opened by the installer.
  2. Save the target repository, local clone and authorized approvers.
  3. Save and apply. Once all required checks pass, the daemon starts automatically.

Until setup is valid, only the local dashboard runs and no agent can start.
NEXT
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then node scripts/service-summary.mjs; fi

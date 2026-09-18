#!/usr/bin/env bash
set -euo pipefail
repo=https://github.com/lucaslodeiro/ai-factory.git
branch=main
dest="$HOME/ai-factory"
skip_tools=false
configure_defaults=false
while (($#)); do
  case "$1" in
    --dir|--branch|--repo)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --dir) dest=$2;; --branch) branch=$2;; --repo) repo=$2;; esac
      shift 2;;
    --defaults) configure_defaults=true; shift;;
    --skip-tools) skip_tools=true; shift;;
    --help) echo 'Usage: bash install.sh [--dir PATH] [--branch BRANCH] [--repo URL] [--skip-tools] [--defaults]'; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done
[[ ! -e "$dest" ]] || { echo "Destination already exists; use scripts/update.sh: $dest" >&2; exit 1; }
export PATH="$HOME/.local/bin:$PATH"
node_ok() { command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; }
if ! "$skip_tools"; then
  [[ $(uname -s) == Darwin ]] || { echo 'Automatic tool installation supports macOS. Install Node 22+, npm, Git, gh, Codex and Claude yourself, then use --skip-tools.' >&2; exit 1; }
  brew_cmd=$(command -v brew || true)
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -z "$brew_cmd" && -x "$candidate" ]]; then brew_cmd=$candidate; fi
  done
  brew_install() {
    [[ -n "$brew_cmd" ]] || { echo 'Install Homebrew from https://brew.sh, then retry.' >&2; exit 1; }
    "$brew_cmd" install "$1"
    export PATH="$("$brew_cmd" --prefix "$1")/bin:$PATH"
  }
  node_ok || brew_install node@22
  git --version >/dev/null 2>&1 || brew_install git
  gh --version >/dev/null 2>&1 || brew_install gh
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  if ! codex --version >/dev/null 2>&1; then
    curl -fsSL https://chatgpt.com/codex/install.sh -o "$tmp/codex.sh"
    sh "$tmp/codex.sh"
  fi
  if ! claude --version >/dev/null 2>&1; then
    curl -fsSL https://claude.ai/install.sh -o "$tmp/claude.sh"
    bash "$tmp/claude.sh" stable
  fi
  hash -r
  codex --version
  claude --version
fi
node_ok || { echo 'Node 22+ is required.' >&2; exit 1; }
npm --version >/dev/null
git --version >/dev/null
git clone --branch "$branch" -- "$repo" "$dest"
cd "$dest"
npm ci
npm run build
npm test
printf '\nConfiguration\n'
printf 'The next wizard saves factory settings and can prepare a private demo target after confirmation.\n'
if "$configure_defaults"; then
  bash scripts/configure.sh --defaults
else
  bash scripts/configure.sh
fi
if [[ ${AI_FACTORY_SKIP_SERVICES:-0} != 1 ]]; then bash scripts/services.sh install all; fi

if node --input-type=module -e "import fs from 'node:fs'; import {parse} from 'dotenv'; const v=parse(fs.readFileSync('.env')); process.exit(['GITHUB_REPOSITORY','FACTORY_REPO_DIR','FACTORY_APPROVERS'].every(k=>v[k]) ? 0 : 1)"; then
  configuration_status='complete'
else
  configuration_status='saved for later'
fi

printf '\n============================================================\n'
printf 'AI Factory installation completed successfully\n'
printf '============================================================\n'
printf 'Engine:        %s\n' "$PWD"
printf 'Configuration: %s\n' "$configuration_status"
printf 'Daemon:        not started\n'
printf 'Services:      daemon and dashboard definitions installed\n'
if [[ ${AI_FACTORY_INSTALL_MODE:-} == no-brew ]]; then
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
  1. Run `npm run configure` if GitHub or target-project setup was left for later.
  2. Authenticate providers: codex login && claude auth login
  3. Validate with `npm run factory -- doctor`.
  4. Start services with `npm run service -- start daemon` and `npm run service -- start dashboard`.

The installer never starts agents automatically. See INSTALL.md for examples.
NEXT

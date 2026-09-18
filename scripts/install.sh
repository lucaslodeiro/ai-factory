#!/usr/bin/env bash
set -euo pipefail
repo=https://github.com/lucaslodeiro/ai-factory.git
branch=bootstrap/mvp
dest="$HOME/ai-factory"
skip_tools=false
while (($#)); do
  case "$1" in
    --dir|--branch|--repo)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --dir) dest=$2;; --branch) branch=$2;; --repo) repo=$2;; esac
      shift 2;;
    --skip-tools) skip_tools=true; shift;;
    --help) echo 'Usage: bash install.sh [--dir PATH] [--branch BRANCH] [--repo URL] [--skip-tools]'; exit 0;;
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
# Never copy credentials from another machine or reuse the old demo target.
node --input-type=module <<'NODE'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const executable = name => {
  try { return execFileSync('which', [name], {encoding:'utf8'}).trim(); }
  catch { return name; }
};
let env = fs.readFileSync('.env.example','utf8');
const values = {FACTORY_REPO_DIR:'', GITHUB_REPOSITORY:'', FACTORY_APPROVERS:'',
  CODEX_COMMAND:executable('codex'), CLAUDE_COMMAND:executable('claude'), GIT_COMMAND:executable('git')};
for (const [key,value] of Object.entries(values)) env = env.replace(new RegExp(`^${key}=.*$`,'m'),`${key}=${JSON.stringify(value)}`);
fs.writeFileSync('.env', env, {flag:'wx', mode:0o600});
NODE
printf '\nFactory installed in %s\n' "$PWD"
printf 'For this toolchain, add these directories to PATH: %s:%s:%s\n' "$(dirname "$(command -v node)")" "$(dirname "$(command -v git)")" "$HOME/.local/bin"
cat <<'NEXT'
Next:
  gh auth login
  gh auth setup-git
  codex login
  claude auth login
Clone your target application and configure .env (see INSTALL.md).
Then run:
  npm run factory -- doctor
  npm run factory -- start
No daemon has been started.
NEXT

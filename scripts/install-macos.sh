#!/usr/bin/env bash
set -euo pipefail

# An uninstall can remove the directory inherited by the caller's shell. Tools
# used below call getcwd(), so recover before invoking any of them.
if ! builtin pwd -P >/dev/null 2>&1; then
  cd "$HOME"
fi

factory_destination="$HOME/ai-factory"
factory_branch=main
factory_repo=https://github.com/lucaslodeiro/ai-factory.git
factory_dashboard_host=127.0.0.1
factory_dashboard_port=4173
installer_arguments=("$@")
installer_argument_count=$#
usage() {
  cat <<EOF
Usage: install-macos.sh [options]

Installs AI Factory and its user-local toolchain on macOS. Apple Command Line
Tools must already be installed. Downloaded tools live under ~/.local/opt and
their launchers under ~/.local/bin.

Options:
  --dir PATH                 Installation directory (default: $HOME/ai-factory)
  --branch BRANCH            Git branch to install (default: main)
  --repo URL                 Factory Git repository (default: https://github.com/lucaslodeiro/ai-factory.git)
  --dashboard-host ADDRESS   Dashboard loopback address (default: 127.0.0.1)
  --dashboard-port PORT      Dashboard port (default: 4173)
  -h, --help                 Show this help without installing anything

Environment:
  AI_FACTORY_SKIP_SERVICES=1  Do not install or start launchd services
  AI_FACTORY_NO_OPEN=1        Do not open the dashboard in a browser
  AI_FACTORY_INSTALL_TESTS=0  Skip npm test during installation (default: run)

After installation:
  ai-factory help
  ai-factory update
  cd ~ && ai-factory uninstall
EOF
}
while (($#)); do
  case "$1" in
    --dir|--branch|--repo|--dashboard-host|--dashboard-port)
      (($# >= 2)) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in
        --dir) factory_destination=$2;;
        --branch) factory_branch=$2;;
        --repo) factory_repo=$2;;
        --dashboard-host) factory_dashboard_host=$2;;
        --dashboard-port) factory_dashboard_port=$2;;
      esac
      shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1. Run with --help." >&2; exit 1;;
  esac
done

if [[ $(uname -s) != Darwin ]]; then
  echo "This installer supports macOS only." >&2
  exit 1
fi

# Fail before downloading toolchains when this is already installed. The
# standard installer repeats this guard to cover direct invocations.
if [[ -d "$factory_destination/engine" && -f "$factory_destination/data/install.json" ]]; then
    echo "AI Factory is already installed at $factory_destination" >&2
    echo "Update it with: ai-factory update" >&2
    echo "For a clean reinstall: cd \"$HOME\" && ai-factory uninstall" >&2
    exit 1
elif [[ -e "$factory_destination/engine" ]]; then
    echo "An incomplete or unrelated destination already exists: $factory_destination" >&2
    backup_destination="${factory_destination}/engine.incomplete-$(date +%Y%m%d-%H%M%S)"
    echo "Preserve it and retry with:" >&2
    echo "  cd \"$factory_destination\"" >&2
    echo "  mv \"$factory_destination/engine\" \"$backup_destination\"" >&2
    echo "  bash /tmp/ai-factory-install-macos.sh --dir \"$factory_destination\"" >&2
  exit 1
fi

local_bin="$HOME/.local/bin"
local_opt="$HOME/.local/opt"
mkdir -p "$local_bin" "$local_opt"
export PATH="$local_bin:$PATH"

temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT

case $(uname -m) in
  arm64) node_arch=arm64; gh_arch=arm64 ;;
  x86_64) node_arch=x64; gh_arch=amd64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

require_builtin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required macOS command not found: $1" >&2
    exit 1
  }
}
for command in curl tar shasum ditto awk sed; do require_builtin "$command"; done

safe_link() {
  source_path=$1
  link_path=$2
  if [[ -e "$link_path" && ! -L "$link_path" ]]; then
    echo "Cannot replace existing file: $link_path" >&2
    exit 1
  fi
  ln -sfn "$source_path" "$link_path"
}

verify_checksum() {
  expected=$1
  file=$2
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  if [[ -z "$expected" || "$actual" != "$expected" ]]; then
    echo "Checksum verification failed for $(basename "$file")" >&2
    exit 1
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}

install_node() {
  checksums="$temporary_dir/node-SHASUMS256.txt"
  curl --proto '=https' --tlsv1.2 -fsSL https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt -o "$checksums"
  archive=$(awk -v suffix="-darwin-$node_arch.tar.gz" 'index($2,suffix) && substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "$checksums")
  expected=$(awk -v file="$archive" '$2==file {print $1; exit}' "$checksums")
  [[ -n "$archive" && -n "$expected" ]] || { echo "Could not resolve the latest Node 22 macOS archive." >&2; exit 1; }

  curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/download/release/latest-v22.x/$archive" -o "$temporary_dir/$archive"
  verify_checksum "$expected" "$temporary_dir/$archive"
  tar -xzf "$temporary_dir/$archive" -C "$temporary_dir"
  directory=${archive%.tar.gz}
  destination="$local_opt/$directory"
  if [[ -e "$destination" ]]; then
    [[ -x "$destination/bin/node" ]] || { echo "Existing Node directory is incomplete: $destination" >&2; exit 1; }
  else
    mv "$temporary_dir/$directory" "$destination"
  fi
  for executable in node npm npx corepack; do safe_link "$destination/bin/$executable" "$local_bin/$executable"; done
}

install_gh() {
  latest_url=$(curl --proto '=https' --tlsv1.2 -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest)
  tag=${latest_url##*/}
  version=${tag#v}
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not resolve the latest GitHub CLI release." >&2; exit 1; }
  archive="gh_${version}_macOS_${gh_arch}.zip"
  base="https://github.com/cli/cli/releases/download/v$version"
  curl --proto '=https' --tlsv1.2 -fsSL "$base/gh_${version}_checksums.txt" -o "$temporary_dir/gh-checksums.txt"
  expected=$(awk -v file="$archive" '$2==file {print $1; exit}' "$temporary_dir/gh-checksums.txt")
  curl --proto '=https' --tlsv1.2 -fsSL "$base/$archive" -o "$temporary_dir/$archive"
  verify_checksum "$expected" "$temporary_dir/$archive"
  ditto -x -k "$temporary_dir/$archive" "$temporary_dir/gh"
  gh_binary="$temporary_dir/gh/gh_${version}_macOS_${gh_arch}/bin/gh"
  [[ -x "$gh_binary" ]] || { echo "GitHub CLI archive has an unexpected layout." >&2; exit 1; }
  destination="$local_opt/gh-$version"
  if [[ -e "$destination" ]]; then
    [[ -x "$destination/bin/gh" ]] || { echo "Existing GitHub CLI directory is incomplete: $destination" >&2; exit 1; }
  else
    mkdir -p "$destination/bin"
    mv "$gh_binary" "$destination/bin/gh"
  fi
  safe_link "$destination/bin/gh" "$local_bin/gh"
}

if ! xcode-select -p >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  echo "Apple Command Line Tools are required for Git and native npm dependencies."
  echo "AI Factory will not open an interactive macOS installer during unattended setup."
  echo "Install the Command Line Tools once with 'xcode-select --install', then rerun this command."
  exit 2
fi

if ! node_ok; then
  echo "Installing the latest Node 22 release in $local_opt..."
  install_node
  hash -r
fi
node_ok || { echo "Node 22 installation did not produce a working executable." >&2; exit 1; }

if ! gh --version >/dev/null 2>&1; then
  echo "Installing the latest GitHub CLI release in $local_opt..."
  install_gh
fi

if ! codex --version >/dev/null 2>&1; then
  echo "Installing Codex CLI non-interactively with its official native installer..."
  curl --proto '=https' --tlsv1.2 -fsSL https://chatgpt.com/codex/install.sh -o "$temporary_dir/codex-install.sh"
  CODEX_NON_INTERACTIVE=1 sh "$temporary_dir/codex-install.sh" </dev/null
fi

if ! claude --version >/dev/null 2>&1; then
  echo "Installing Claude Code stable non-interactively with its official native installer..."
  curl --proto '=https' --tlsv1.2 -fsSL https://claude.ai/install.sh -o "$temporary_dir/claude-install.sh"
  bash "$temporary_dir/claude-install.sh" stable </dev/null
fi

hash -r
node --version
npm --version
git --version
gh --version
codex --version
claude --version

core_branch=$factory_branch
if [[ $factory_repo =~ ^https://github\.com/([^/]+)/([^/]+)(\.git)?$ ]]; then
  core_owner=${BASH_REMATCH[1]}
  core_repository=${BASH_REMATCH[2]%.git}
elif [[ $factory_repo =~ ^git@github\.com:([^/]+)/([^/]+)(\.git)?$ ]]; then
  core_owner=${BASH_REMATCH[1]}
  core_repository=${BASH_REMATCH[2]%.git}
else
  core_owner=lucaslodeiro
  core_repository=ai-factory
  core_branch=main
  echo "The requested repository is not a GitHub URL; downloading the bootstrap installer from lucaslodeiro/ai-factory main."
fi
curl --proto '=https' --tlsv1.2 -fsSL "https://raw.githubusercontent.com/$core_owner/$core_repository/$core_branch/scripts/install-core.sh" \
  -o "$temporary_dir/ai-factory-install-core.sh"
if ((installer_argument_count)); then
  bash "$temporary_dir/ai-factory-install-core.sh" "${installer_arguments[@]}"
else
  bash "$temporary_dir/ai-factory-install-core.sh"
fi

#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Darwin ]]; then
  echo "This installer supports macOS only." >&2
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
  curl -fsSL https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt -o "$checksums"
  archive=$(awk -v suffix="-darwin-$node_arch.tar.gz" 'index($2,suffix) && substr($2,length($2)-length(suffix)+1)==suffix {print $2; exit}' "$checksums")
  expected=$(awk -v file="$archive" '$2==file {print $1; exit}' "$checksums")
  [[ -n "$archive" && -n "$expected" ]] || { echo "Could not resolve the latest Node 22 macOS archive." >&2; exit 1; }

  curl -fsSL "https://nodejs.org/download/release/latest-v22.x/$archive" -o "$temporary_dir/$archive"
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
  latest_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest)
  tag=${latest_url##*/}
  version=${tag#v}
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not resolve the latest GitHub CLI release." >&2; exit 1; }
  archive="gh_${version}_macOS_${gh_arch}.zip"
  base="https://github.com/cli/cli/releases/download/v$version"
  curl -fsSL "$base/gh_${version}_checksums.txt" -o "$temporary_dir/gh-checksums.txt"
  expected=$(awk -v file="$archive" '$2==file {print $1; exit}' "$temporary_dir/gh-checksums.txt")
  curl -fsSL "$base/$archive" -o "$temporary_dir/$archive"
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
  echo "macOS will open its installer. Finish it, then run this script again."
  xcode-select --install >/dev/null 2>&1 || true
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
  echo "Installing Codex CLI with its official native installer..."
  curl -fsSL https://chatgpt.com/codex/install.sh -o "$temporary_dir/codex-install.sh"
  sh "$temporary_dir/codex-install.sh"
fi

if ! claude --version >/dev/null 2>&1; then
  echo "Installing Claude Code stable with its official native installer..."
  curl -fsSL https://claude.ai/install.sh -o "$temporary_dir/claude-install.sh"
  bash "$temporary_dir/claude-install.sh" stable
fi

hash -r
node --version
npm --version
git --version
gh --version
codex --version
claude --version

curl -fsSL https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install.sh \
  -o "$temporary_dir/ai-factory-install.sh"
bash "$temporary_dir/ai-factory-install.sh" --skip-tools "$@"

printf '\nThe no-Homebrew toolchain lives under %s.\n' "$HOME/.local"
printf 'Add this line to your shell profile before opening a new terminal:\n  export PATH="$HOME/.local/bin:$PATH"\n'

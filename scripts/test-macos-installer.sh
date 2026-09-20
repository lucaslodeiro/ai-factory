#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/home"

cat > "$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
exit 99
MOCK
chmod +x "$fixture/bin/curl"
PATH="$fixture/bin:/usr/bin:/bin" HOME="$fixture/home" CURL_LOG="$fixture/help-curl.log" \
  bash "$root/scripts/install-macos.sh" --help > "$fixture/help.out"
grep -q -- '--dashboard-port PORT' "$fixture/help.out"
grep -q -- 'AI_FACTORY_SKIP_SERVICES' "$fixture/help.out"
grep -q -- 'ai-factory update' "$fixture/help.out"
[[ ! -e "$fixture/help-curl.log" ]]
set +e
PATH="$fixture/bin:/usr/bin:/bin" HOME="$fixture/home" CURL_LOG="$fixture/bogus-curl.log" \
  bash "$root/scripts/install-macos.sh" --bogus > "$fixture/bogus.out" 2>&1
bogus_status=$?
set -e
[[ $bogus_status -eq 1 ]]
grep -q 'Unknown option: --bogus. Run with --help.' "$fixture/bogus.out"
[[ ! -e "$fixture/bogus-curl.log" ]]

for executable in node npm git gh codex claude; do
  cat > "$fixture/bin/$executable" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  chmod +x "$fixture/bin/$executable"
done

cat > "$fixture/bin/uname" <<'MOCK'
#!/usr/bin/env bash
if [[ ${1:-} == -m ]]; then echo arm64; else echo Darwin; fi
MOCK
cat > "$fixture/bin/xcode-select" <<'MOCK'
#!/usr/bin/env bash
[[ ${1:-} == -p ]]
MOCK
cat > "$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
output=
while (($#)); do
  if [[ $1 == -o ]]; then output=$2; shift 2; else shift; fi
done
[[ -n "$output" ]] || exit 1
cat > "$output" <<'PRIVATE_INSTALLER'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGS"
PRIVATE_INSTALLER
MOCK
chmod +x "$fixture/bin/uname" "$fixture/bin/xcode-select" "$fixture/bin/curl"

PATH="$fixture/bin:/usr/bin:/bin" HOME="$fixture/home" MOCK_ARGS="$fixture/args" \
  bash "$root/scripts/install-macos.sh" --dir "/tmp/path with spaces" >/dev/null

printf '%s\n' --dir "/tmp/path with spaces" > "$fixture/expected"
cmp "$fixture/expected" "$fixture/args"

# Exercise verified Node/GitHub CLI installation with deterministic archives.
for executable in node npm gh; do
  cat > "$fixture/bin/$executable" <<'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
  chmod +x "$fixture/bin/$executable"
done
cat > "$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
arguments=" $* "
output=
previous=
for argument in "$@"; do
  if [[ $previous == -o ]]; then output=$argument; break; fi
  previous=$argument
done
case "$arguments" in
  *"https://nodejs.org/download/release/latest-v22.x/SHASUMS256.txt"*) printf 'aaa  node-v22.23.2-darwin-arm64.tar.gz\n' > "$output" ;;
  *"https://nodejs.org/download/release/latest-v22.x/node-v22.23.2-darwin-arm64.tar.gz"*) : > "$output" ;;
  *"https://github.com/cli/cli/releases/latest"*) printf 'https://github.com/cli/cli/releases/tag/v2.101.0' ;;
  *"gh_2.101.0_checksums.txt"*) printf 'bbb  gh_2.101.0_macOS_arm64.zip\n' > "$output" ;;
  *"gh_2.101.0_macOS_arm64.zip"*) : > "$output" ;;
  *"https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-core.sh"*)
    cat > "$output" <<'PRIVATE_INSTALLER'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGS"
PRIVATE_INSTALLER
    ;;
  *) echo "Unexpected curl invocation: $*" >&2; exit 1 ;;
esac
MOCK
cat > "$fixture/bin/shasum" <<'MOCK'
#!/usr/bin/env bash
case ${3##*/} in
  node-*) echo "aaa  $3" ;;
  gh_*) echo "bbb  $3" ;;
  *) exit 1 ;;
esac
MOCK
cat > "$fixture/bin/tar" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
destination=
previous=
for argument in "$@"; do
  if [[ $previous == -C ]]; then destination=$argument; break; fi
  previous=$argument
done
directory="$destination/node-v22.23.2-darwin-arm64/bin"
mkdir -p "$directory"
for executable in node npm npx corepack; do printf '#!/bin/sh\nexit 0\n' > "$directory/$executable"; chmod +x "$directory/$executable"; done
MOCK
cat > "$fixture/bin/ditto" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do destination=$argument; done
directory="$destination/gh_2.101.0_macOS_arm64/bin"
mkdir -p "$directory"
printf '#!/bin/sh\nexit 0\n' > "$directory/gh"
chmod +x "$directory/gh"
MOCK
chmod +x "$fixture/bin/curl" "$fixture/bin/shasum" "$fixture/bin/tar" "$fixture/bin/ditto"

rm -rf "$fixture/home/.local" "$fixture/args"
PATH="$fixture/bin:/usr/bin:/bin" HOME="$fixture/home" MOCK_ARGS="$fixture/args" \
  bash "$root/scripts/install-macos.sh" >/dev/null
[[ -L "$fixture/home/.local/bin/node" && -L "$fixture/home/.local/bin/gh" ]]
printf '%s\n' > "$fixture/expected"
cmp "$fixture/expected" "$fixture/args"

# Provider installers must never open their console or read from the terminal.
for executable in codex claude; do
  cat > "$fixture/bin/$executable" <<'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
  chmod +x "$fixture/bin/$executable"
done
cat > "$fixture/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
arguments=" $* "
output=
previous=
for argument in "$@"; do
  if [[ $previous == -o ]]; then output=$argument; break; fi
  previous=$argument
done
case "$arguments" in
  *"https://chatgpt.com/codex/install.sh"*)
    cat > "$output" <<'PROVIDER'
#!/usr/bin/env bash
set -euo pipefail
[[ ${CODEX_NON_INTERACTIVE:-} == 1 && ${CI:-} == 1 && ${NO_COLOR:-} == 1 ]]
if IFS= read -r _; then echo 'Codex installer received interactive input' >&2; exit 31; fi
printf 'codex noninteractive\n' >> "$PROVIDER_LOG"
printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/codex"
chmod +x "$HOME/.local/bin/codex"
PROVIDER
    ;;
  *"https://claude.ai/install.sh"*)
    cat > "$output" <<'PROVIDER'
#!/usr/bin/env bash
set -euo pipefail
[[ ${CI:-} == 1 && ${NO_COLOR:-} == 1 && ${TERM:-} == dumb && ${1:-} == stable ]]
if IFS= read -r _; then echo 'Claude installer received interactive input' >&2; exit 32; fi
printf 'claude noninteractive\n' >> "$PROVIDER_LOG"
printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
PROVIDER
    ;;
  *"https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install-core.sh"*)
    cat > "$output" <<'PRIVATE_INSTALLER'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_ARGS"
PRIVATE_INSTALLER
    ;;
  *) echo "Unexpected curl invocation: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$fixture/bin/curl"
rm -f "$fixture/home/.local/bin/codex" "$fixture/home/.local/bin/claude" "$fixture/provider.log"
PATH="$fixture/bin:/usr/bin:/bin" HOME="$fixture/home" MOCK_ARGS="$fixture/args" PROVIDER_LOG="$fixture/provider.log" \
  bash "$root/scripts/install-macos.sh" >/dev/null
printf 'codex noninteractive\nclaude noninteractive\n' > "$fixture/providers-expected"
cmp "$fixture/providers-expected" "$fixture/provider.log"

# A missing Apple toolchain stops cleanly instead of opening the macOS GUI.
cat > "$fixture/bin/xcode-select" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$XCODE_LOG"
exit 1
MOCK
cat > "$fixture/bin/git" <<'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
chmod +x "$fixture/bin/xcode-select" "$fixture/bin/git"
set +e
PATH="$fixture/bin:/usr/bin:/bin" HOME="$fixture/home" XCODE_LOG="$fixture/xcode.log" \
  bash "$root/scripts/install-macos.sh" >"$fixture/clt.out" 2>&1
status=$?
set -e
[[ $status -eq 2 ]]
grep -q "xcode-select --install" "$fixture/clt.out"
grep -qx -- '-p' "$fixture/xcode.log"

echo "PASS: user-local preflight, verified tool installation, non-interactive providers and argument forwarding"

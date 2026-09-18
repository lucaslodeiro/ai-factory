#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/home"

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
  bash "$root/scripts/install-macos-no-brew.sh" --dir "/tmp/path with spaces" --defaults >/dev/null

printf '%s\n' --skip-tools --dir "/tmp/path with spaces" --defaults > "$fixture/expected"
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
  *"https://raw.githubusercontent.com/lucaslodeiro/ai-factory/main/scripts/install.sh"*)
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
  bash "$root/scripts/install-macos-no-brew.sh" --defaults >/dev/null
[[ -L "$fixture/home/.local/bin/node" && -L "$fixture/home/.local/bin/gh" ]]
printf '%s\n' --skip-tools --defaults > "$fixture/expected"
cmp "$fixture/expected" "$fixture/args"

echo "PASS: no-Homebrew preflight, verified local tool installation and argument forwarding"

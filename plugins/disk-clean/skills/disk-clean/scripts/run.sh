#!/usr/bin/env bash
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
plugin_root=$(cd "$here/../../.." && pwd)
case "$(uname -s)/$(uname -m)" in
  Darwin/*) asset=disk-clean-macos-universal.tar.gz ;;
  Linux/x86_64) asset=disk-clean-linux-x86_64.tar.gz ;;
  Linux/aarch64 | Linux/arm64) asset=disk-clean-linux-arm64.tar.gz ;;
  *) asset= ;;
esac

data=${1:-}
[ "$#" -gt 0 ] && shift
case "$data" in
  '' | *\$\{*) data="$HOME/.cache/disk-clean" ;;
esac

version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$plugin_root/.claude-plugin/plugin.json" | head -n 1)
case "$version" in
  '' | *[!0-9A-Za-z.+-]*)
    echo "disk-clean: could not read a valid version from $plugin_root/.claude-plugin/plugin.json" >&2
    exit 1
    ;;
esac

bin="$data/bin/disk-clean-$version"
if [ -x "$bin" ]; then
  exec "$bin" "$@"
fi

mkdir -p "$data/bin"
tmp=$(mktemp -d "$data/bin/.install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

download() {
  [ -n "$asset" ] || return 1
  local url="https://github.com/omridevk/mopper/releases/download/disk-clean--v$version/$asset"
  command -v curl >/dev/null 2>&1 || return 1
  local sum=(shasum -a 256)
  command -v sha256sum >/dev/null 2>&1 && sum=(sha256sum)
  command -v "${sum[0]}" >/dev/null 2>&1 || return 1
  echo "disk-clean: downloading release v$version..." >&2
  curl --proto '=https' --tlsv1.2 -fsL --retry 2 -o "$tmp/$asset" "$url" || return 1
  curl --proto '=https' --tlsv1.2 -fsL --retry 2 -o "$tmp/$asset.sha256" "$url.sha256" || return 1
  if [ "$(awk '{print $2}' "$tmp/$asset.sha256")" != "$asset" ] ||
    ! (cd "$tmp" && "${sum[@]}" -c "$asset.sha256" >/dev/null 2>&1); then
    echo "disk-clean: checksum mismatch on the downloaded v$version release, refusing to run it" >&2
    exit 1
  fi
  tar -xzf "$tmp/$asset" -C "$tmp" disk-clean || return 1
  mv "$tmp/disk-clean" "$tmp/ready"
}

build() {
  command -v cargo >/dev/null 2>&1 || return 1
  echo "disk-clean: no release download for v$version, building from source with cargo (first run only)..." >&2
  CARGO_TARGET_DIR="$data/target" cargo build --release --locked \
    --manifest-path "$plugin_root/cli/Cargo.toml" >&2 || return 1
  cp "$data/target/release/disk-clean" "$tmp/ready"
}

if ! download && ! build; then
  echo "disk-clean: could not get the disk-clean binary for v$version." >&2
  echo "  Either install Rust (https://rustup.rs) so it can be built from source on first run," >&2
  echo "  or install a plugin version that has a published release:" >&2
  echo "  https://github.com/omridevk/mopper/releases" >&2
  exit 1
fi

chmod 755 "$tmp/ready"
mv -f "$tmp/ready" "$bin"
rm -rf "$tmp"
trap - EXIT
exec "$bin" "$@"

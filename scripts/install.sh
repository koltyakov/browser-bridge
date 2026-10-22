#!/bin/sh
set -eu
umask 077

if [ "${1:-}" = '--help' ]; then
  echo 'Install Browser Bridge from GitHub Releases. Optional: BBX_VERSION, BBX_EXTENSION_ID, BBX_BROWSER, BBX_INSTALL_DIR.'
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo 'Unexpected arguments. Use --help for installer options.' >&2
  exit 1
fi

version="${BBX_VERSION:-}"
extension_id="${BBX_EXTENSION_ID:-jjjkmmcdkpcgamlopogicbnnhdgebhie}"
browser="${BBX_BROWSER:-chrome}"
install_dir="${BBX_INSTALL_DIR:-$HOME/.local/bin}"
if ! printf '%s\n' "$extension_id" | grep -Eq '^[a-z]{32}$'; then
  echo 'Invalid extension ID' >&2
  exit 1
fi
case "$browser" in chrome|edge|brave|chromium|arc) ;; *) echo 'Unsupported browser' >&2; exit 1;; esac
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo 'Unsupported OS' >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
base='https://github.com/koltyakov/browser-bridge/releases/latest/download'
if [ -n "$version" ]; then
  version="${version#v}"
  if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$'; then
    echo 'Invalid version' >&2
    exit 1
  fi
  base="https://github.com/koltyakov/browser-bridge/releases/download/v$version"
fi

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo 'Missing required command: curl or wget' >&2
    exit 1
  fi
}

asset="bbx-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
download "$base/checksums.txt" "$tmp/checksums.txt"
download "$base/$asset" "$tmp/bbx"
expected="$(awk -v file="$asset" '$2 == file {print $1}' "$tmp/checksums.txt")"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/bbx" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmp/bbx" | awk '{print $1}')"
else
  echo 'Missing required command: sha256sum or shasum' >&2
  exit 1
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo 'Binary checksum mismatch' >&2
  exit 1
fi
chmod 700 "$tmp/bbx"
BBX_AUTO_UPDATE=off "$tmp/bbx" install-self --bin-dir "$install_dir" --no-restart
BBX_AUTO_UPDATE=off "$install_dir/bbx" install "$extension_id" --browser "$browser"
BBX_AUTO_UPDATE=off "$install_dir/bbx" restart
echo "Installed Browser Bridge to $install_dir/bbx"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add this directory to your shell profile PATH: %s\n' "$install_dir" ;;
esac

#!/bin/sh
set -eu

# Install a released companion without Node, npm, Bun, or administrator access.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  Linux-x86_64) target=linux-x64-baseline ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  *) echo 'This computer is not supported by the Browser Bridge installer.' >&2; exit 1 ;;
esac
base=https://github.com/koltyakov/browser-bridge/releases/latest/download
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
echo 'Downloading Browser Bridge...'
curl --fail --location --proto '=https' --tlsv1.2 "$base/bbx-$target" -o "$temporary/bbx-$target"
curl --fail --location --proto '=https' --tlsv1.2 "$base/SHA256SUMS" -o "$temporary/SHA256SUMS"
expected=$(awk -v name="bbx-$target" '$2 == name { print $1 }' "$temporary/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/bbx-$target" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$temporary/bbx-$target" | awk '{print $1}')
fi
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  echo 'Download verification failed. Your current installation has not changed.' >&2
  exit 1
fi
chmod 755 "$temporary/bbx-$target"
"$temporary/bbx-$target" setup "$@"

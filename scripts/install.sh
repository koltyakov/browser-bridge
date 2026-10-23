#!/bin/sh
set -eu
umask 077

if [ "${1:-}" = '--help' ]; then
  echo 'Install Browser Bridge from GitHub Releases. BBX_VERSION accepts a major-minor release line such as 2.0, or an exact version. Optional: BBX_EXTENSION_ID, BBX_BROWSER, BBX_INSTALL_DIR.'
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo 'Unexpected arguments. Use --help for installer options.' >&2
  exit 1
fi

version="${BBX_VERSION:-}"
# BEGIN GENERATED EXTENSION_ID
extension_id="${BBX_EXTENSION_ID:-jjjkmmcdkpcgamlopogicbnnhdgebhie}"
# END GENERATED EXTENSION_ID
browser="${BBX_BROWSER:-chrome}"
install_dir="${BBX_INSTALL_DIR:-$HOME/.local/bin}"
if ! printf '%s\n' "$extension_id" | grep -Eq '^[a-z]{32}$'; then
  echo 'Invalid extension ID' >&2
  exit 1
fi
# BEGIN GENERATED BROWSERS
case "$browser" in chrome|edge|brave|chromium|arc) ;; *) echo 'Unsupported browser' >&2; exit 1;; esac
# END GENERATED BROWSERS
# BEGIN GENERATED PLATFORMS
case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64) asset='bbx-darwin-arm64';;
  Darwin:x86_64|Darwin:amd64) asset='bbx-darwin-x64';;
  Linux:arm64|Linux:aarch64) asset='bbx-linux-arm64';;
  Linux:x86_64|Linux:amd64) asset='bbx-linux-x64';;
  *) echo 'Unsupported OS or architecture' >&2; exit 1;;
esac
# END GENERATED PLATFORMS
base='https://github.com/koltyakov/browser-bridge/releases/latest/download'
if [ -n "$version" ]; then
  version="${version#v}"
  if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+(\.[0-9]+([.-][a-zA-Z0-9.-]+)?)?$'; then
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

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
if printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+$'; then
  release_line="$version"
  best_patch=-1
  page=1
  while :; do
    download "https://api.github.com/repos/koltyakov/browser-bridge/releases?per_page=100&page=$page" "$tmp/releases.json"
    # Read only release-level fields, ignoring nested assets and escaped text.
    # Tokenizing strings also supports compact JSON without requiring jq or Node.
    selection="$(awk -v line="$release_line" '
      BEGIN { split(line, parts, "."); pattern = "^v" parts[1] "\\." parts[2] "\\.[0-9]+$"; best = -1 }
      {
        for (i = 1; i <= length($0); i++) {
          c = substr($0, i, 1)
          if (quoted) {
            if (escaped) { text = text "\\" c; escaped = 0 }
            else if (c == "\\") escaped = 1
            else if (c == "\"") {
              quoted = 0
              if (depth == 2) {
                if (waiting) { if (key == "tag_name") tag = text; waiting = 0 }
                else key = text
              }
            } else text = text c
            continue
          }
          if (c ~ /[[:space:]]/) continue
          if (!started) { if (c != "[") exit 1; started = 1 }
          if (c == "\"") { quoted = 1; text = "" }
          else if (c == "{" || c == "[") {
            depth++
            if (c == "{" && depth == 2) { tag = ""; draft = 1; prerelease = 1; key = ""; waiting = 0 }
          } else if (c == "}" || c == "]") {
            if (c == "}" && depth == 2) {
              count++
              if (!draft && !prerelease && tag ~ pattern) {
                split(tag, parts, ".")
                if (parts[3] + 0 > best) best = parts[3] + 0
              }
            }
            depth--
          } else if (depth == 2) {
            if (c == ":") waiting = 1
            else if (c == ",") { waiting = 0; key = "" }
            else if (waiting) {
              if (substr($0, i, 5) == "false") {
                if (key == "draft") draft = 0
                if (key == "prerelease") prerelease = 0
              }
              waiting = 0
            }
          }
        }
      }
      END { if (!started || depth != 0 || quoted) exit 1; printf "%d %.0f\n", count, best }
    ' "$tmp/releases.json")" || {
      echo 'Invalid GitHub release list' >&2
      exit 1
    }
    release_count="${selection%% *}"
    patch="${selection#* }"
    if [ "$patch" -gt "$best_patch" ]; then best_patch="$patch"; fi
    if [ "$release_count" -lt 100 ]; then break; fi
    page=$((page + 1))
  done
  if [ "$best_patch" -lt 0 ]; then
    echo "No published stable release found for $release_line.x" >&2
    exit 1
  fi
  version="$release_line.$best_patch"
  base="https://github.com/koltyakov/browser-bridge/releases/download/v$version"
  echo "Selected Browser Bridge v$version for $release_line.x"
fi
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
if command -v npm >/dev/null 2>&1; then
  if npm_root="$(npm root --global 2>/dev/null)"; then
    if [ -f "$npm_root/@browserbridge/bbx/package.json" ]; then
      echo 'Removing the legacy global npm package @browserbridge/bbx...'
      if ! npm uninstall --global @browserbridge/bbx; then
        echo 'Warning: could not remove the legacy npm package. Run npm uninstall -g @browserbridge/bbx manually if it still shadows the standalone CLI.' >&2
      fi
    fi
  else
    echo 'Warning: could not check for the legacy global npm package. Continuing with standalone installation.' >&2
  fi
fi
BBX_AUTO_UPDATE=off "$tmp/bbx" install-self --bin-dir "$install_dir" --no-restart
BBX_AUTO_UPDATE=off "$install_dir/bbx" install "$extension_id" --browser "$browser"
BBX_AUTO_UPDATE=off "$install_dir/bbx" restart
echo "Installed Browser Bridge to $install_dir/bbx"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add this directory to your shell profile PATH: %s\n' "$install_dir" ;;
esac

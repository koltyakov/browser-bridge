#!/bin/sh
set -eu
umask 077

if [ "${1:-}" = '--help' ]; then
  echo 'Install Browser Bridge from GitHub Releases. Detects supported browsers with the extension installed. BBX_VERSION accepts a major-minor release line such as 2.0, or an exact version. Optional: BBX_EXTENSION_ID, BBX_BROWSER (one browser override), BBX_INSTALL_DIR.'
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
browser="${BBX_BROWSER:-}"
install_dir="${BBX_INSTALL_DIR:-$HOME/.local/bin}"
case "$install_dir" in /*) ;; *) install_dir="$PWD/$install_dir";; esac
if ! printf '%s\n' "$extension_id" | grep -Eq '^[a-z]{32}$'; then
  echo 'Invalid extension ID' >&2
  exit 1
fi
# BEGIN GENERATED BROWSERS
case "$browser" in ''|chrome|edge|brave|chromium|arc|chrome-beta|chrome-dev|chrome-canary|chrome-for-testing|vivaldi|opera) ;; *) echo 'Unsupported browser' >&2; exit 1;; esac
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
volta_status=absent
if command -v volta >/dev/null 2>&1; then
  if volta_packages="$(volta list --format plain @browserbridge/bbx 2>/dev/null)"; then
    if printf '%s\n' "$volta_packages" | grep -Eq '^package @browserbridge/bbx@[^[:space:]]+ /'; then
      volta_status=installed
      echo 'Warning: Volta manages an existing @browserbridge/bbx installation. It has not been removed and may shadow the standalone CLI.' >&2
      echo 'After installation, remove it manually with: volta uninstall @browserbridge/bbx' >&2
      echo 'Then open a new terminal and run bbx --version to verify that the standalone CLI is selected.' >&2
    fi
  else
    volta_status=unknown
    echo 'Warning: could not inspect Volta packages. Skipping automatic npm removal to avoid deleting a Volta-managed installation.' >&2
    echo 'Check with: volta list --format plain @browserbridge/bbx. If installed, remove it manually with: volta uninstall @browserbridge/bbx' >&2
  fi
fi
if [ "$volta_status" = absent ] && command -v npm >/dev/null 2>&1; then
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
if [ -n "${BBX_EXTENSION_ID:-}" ]; then
  export BROWSER_BRIDGE_EXTENSION_ID="$extension_id"
fi
BBX_AUTO_UPDATE=off BBX_BROWSER="$browser" "$tmp/bbx" install-self --bin-dir "$install_dir" --no-restart
set -- install
if [ -n "${BBX_EXTENSION_ID:-}" ]; then
  set -- "$@" "$extension_id"
fi
if [ -n "$browser" ]; then
  set -- "$@" --browser "$browser"
fi
BBX_AUTO_UPDATE=off "$install_dir/bbx" "$@"
BBX_AUTO_UPDATE=off "$install_dir/bbx" restart
echo "Installed Browser Bridge to $install_dir/bbx"

# Prepend even when the directory is already present later in PATH, where a
# package-manager shim could still win. Quote custom paths for shell startup files.
if [ "$install_dir" = "$HOME/.local/bin" ]; then
  path_entry='case "$PATH" in "$HOME/.local/bin"|"$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'
  path_command='export PATH="$HOME/.local/bin:$PATH"'
else
  quoted_install_dir="$(printf '%s' "$install_dir" | sed "s/'/'\\\\''/g")"
  path_entry="case \"\$PATH\" in '$quoted_install_dir'|'$quoted_install_dir':*) ;; *) export PATH='$quoted_install_dir':\"\$PATH\" ;; esac"
  path_command="export PATH='$quoted_install_dir':\"\$PATH\""
fi
configure_path() {
  if [ -f "$1" ] && grep -Fqx "$path_entry" "$1"; then
    return
  fi
  if printf '\n# Browser Bridge\n%s\n' "$path_entry" >> "$1"; then
    printf 'Configured Browser Bridge PATH in %s for future terminals.\n' "$1"
  else
    printf 'Warning: could not update %s. Configure PATH manually with: %s\n' "$1" "$path_command" >&2
    return 1
  fi
}
case "${SHELL:-}" in
  */zsh|zsh)
    configure_path "${ZDOTDIR:-$HOME}/.zprofile"
    configure_path "${ZDOTDIR:-$HOME}/.zshrc"
    ;;
  */bash|bash)
    configure_path "$HOME/.bashrc"
    if [ -f "$HOME/.bash_profile" ]; then
      configure_path "$HOME/.bash_profile"
    elif [ -f "$HOME/.bash_login" ]; then
      configure_path "$HOME/.bash_login"
    else
      configure_path "$HOME/.profile"
    fi
    ;;
  */sh|sh|*/dash|dash|*/ksh|ksh)
    configure_path "$HOME/.profile"
    ;;
  *)
    printf 'Warning: shell %s is not supported for automatic PATH configuration. Add this to its startup configuration: %s\n' "${SHELL:-unknown}" "$path_command" >&2
    ;;
esac
if [ "$(command -v bbx || true)" != "$install_dir/bbx" ]; then
  printf 'For this terminal, run: %s\n' "$path_command"
fi
export PATH="$install_dir:$PATH"
if [ "$(command -v bbx)" != "$install_dir/bbx" ]; then
  echo 'Could not select the installed bbx through PATH.' >&2
  exit 1
fi

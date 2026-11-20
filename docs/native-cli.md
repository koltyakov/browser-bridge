# Native CLI

Browser Bridge runs its CLI, native messaging host, daemon, MCP server, browser registration, and agent setup in one Go executable. The npm package downloads and launches that executable with zero runtime npm dependencies.

For an existing Node.js installation, follow the [v1 to v2 migration guide](./migration-v1-to-v2.md), including agent configuration repair and CLI output changes.

## Install through npm

Install the [Chrome extension](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie), then use Node.js 20 or later:

```sh
npm install -g @browserbridge/bbx
```

The wrapper selects macOS arm64/x64, Linux arm64/x64, or Windows x64. The npm package version does not constrain the native version. Installation queries GitHub Releases for the latest stable binary and verifies its size, its SHA-256 from the release's `checksums.txt`, and its executable self-test. Drafts and prereleases are excluded.

To match your extension's release line, set `BBX_VERSION` during installation:

```sh
BBX_VERSION=2.0 npm install -g @browserbridge/bbx
```

This selects the highest published stable `2.0.x` patch. An exact native version such as `2.0.3` also works. If the requested release or platform asset is unavailable, installation fails instead of substituting another release line. Without a selector, or with `BBX_VERSION=latest`, installation uses GitHub's latest stable release. The bootstrap does not detect the installed extension version automatically.

A global npm install initializes browser registration. A local dependency install downloads the binary without registering a browser. If install scripts were skipped, the launcher fetches the binary on first use; run `bbx install` to register it. Source checkouts skip the npm bootstrap so development does not download a published runtime.

If the extension does not connect, run `bbx install`, or `bbx install --browser chrome` for Google Chrome on Linux. Choose your agent under **Connect agent** in the extension, then Enable window access. See the [quickstart](./quickstart.md).

On macOS and Linux, postinstall replaces npm-owned command symlinks with shell launchers. Each invocation verifies the cached executable against the selected release's SHA-256 using `/usr/bin/openssl`, then replaces the shell process with Go. The launchers preserve npm installation ownership and all four command aliases. They keep the executable outside `node_modules` and leave the original JavaScript entrypoints intact.

If OpenSSL or the cached executable is missing, the shell delegates to the verified Node launcher, which can download the selected executable again. Windows, skipped install scripts, and package managers without npm-style symlinks also use the Node launcher. A checksum mismatch fails before Go executes; it does not bypass verification or select another version.

The downloaded Go executable runs without Node and contains the runtime metadata and agent skills it needs. Node is still required for npm installation and launcher fallback.

`bbx install-mcp` writes the absolute, symlink-resolved Go binary path with `mcp serve` into every supported MCP config format. It does not write npm, npx, Node, or a bare `bbx` command that might resolve to a package-manager shim. Native messaging uses a small shell or Windows command launcher only to supply the environment and `--native-host`; that launcher executes the binary directly. Installation also migrates recognized older Browser Bridge wrapper entries and updates recognized native MCP paths to the current binary, preserving user settings. Custom wrappers and remote transports are not automatically replaced.

## Install without Node.js

Run the GitHub-hosted installer for your platform. On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.sh | sh
```

On Windows x64, run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.ps1 | iex
```

The installers select the latest stable native patch in the newest installed
extension's `major.minor` line, or GitHub's latest stable release when no extension
is detected. They verify SHA-256, install to `~/.local/bin`, register supported
browsers, and restart the daemon. Existing native registrations are refreshed.
Windows adds the installation directory to your user `PATH`. Keep `~/.local/bin`
on your shell's `PATH` on macOS and Linux.

After verifying the download, the installers try to remove an existing global `@browserbridge/bbx` npm package before installing the standalone CLI. If npm is unavailable, they skip this step. If detection or removal fails, they warn and continue without requesting elevated permissions.

The setup panel shows the short commands above, with no version argument.
Detection uses a checksum-verified latest binary as a read-only bootstrap.
`bbx update status` runs with isolated temporary state and automatic updates off,
using the shared native browser/profile scanner. No existing installation is
changed during discovery. If the latest published binary predates discovery
support, the installer warns and uses latest stable instead.

After detecting an extension line, the installer scans published GitHub releases
and selects its highest stable patch. It verifies that version's checksums even
when the bootstrap can be reused, and fails if no matching release is available
rather than substituting another line. This may download a second native binary
when the extension line differs from latest.

Optional `BBX_VERSION` or PowerShell `-Version` overrides detection. Use a line
such as `2.0`, an exact version such as `2.0.3`, or `latest` to explicitly select
GitHub's latest stable release. `BBX_BROWSER` and `-Browser` restrict registration,
not version detection across other installed browsers.

For an unpacked extension, set `BBX_EXTENSION_ID` for the Unix script or pass `-ExtensionId` to the PowerShell script. The Chrome Web Store ID is the default and is omitted from the setup command. Browsers are detected automatically; use `BBX_BROWSER` or `-Browser` to restrict installation to one supported browser, and `BBX_INSTALL_DIR` or `-InstallDir` for another installation directory. Run with `--help` or `-Help` for options.

### Download manually

Download a standalone executable from [GitHub Releases](https://github.com/koltyakov/browser-bridge/releases/latest). Choose the asset for your operating system and CPU:

| Platform | Asset |
| --- | --- |
| macOS, Apple silicon | `bbx-darwin-arm64` |
| macOS, Intel | `bbx-darwin-x64` |
| Linux, arm64 | `bbx-linux-arm64` |
| Linux, x64 | `bbx-linux-x64` |
| Windows, arm64 | `bbx-windows-arm64.exe` |
| Windows, x64 | `bbx-windows-x64.exe` |

On macOS or Linux, replace `/path/to/downloaded-binary` below with the downloaded file's path:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 /path/to/downloaded-binary "$HOME/.local/bin/bbx"
export PATH="$HOME/.local/bin:$PATH"
bbx install
```

Keep `~/.local/bin` on your shell's `PATH` for future sessions. On Windows, rename the downloaded file to `bbx.exe`, place it in a permanent folder, add that folder to your user `PATH`, and run `bbx install` in a new terminal. You can also run `.\bbx.exe install` from that folder to register the browser before configuring `PATH`.

`bbx install` registers the native messaging host using the executable's location, so do not move or delete the binary afterward. It detects Browser Bridge across profiles in the standard user-data directories for Chrome Stable, Beta, Dev, Canary, Chrome for Testing, Edge, Brave, Chromium, Arc, Vivaldi, and Opera, and repairs existing registrations. Detection checks the requested extension ID in extension directories and profile registration metadata, including unpacked installs and browsers with root-level profile metadata. It does not inspect browsing history or cookies, change browser preferences, or enable window access.

If nothing is detected, installation falls back to Chromium on Linux or Chrome on macOS/Windows. Use `bbx install --browser brave` or `BBX_BROWSER=brave bbx install` to select one browser explicitly; `--all` registers every supported browser even without a detected extension. Automatic registration preserves existing custom extension origins and adds the requested ID when it is installed in that browser. Unreadable profiles produce warnings rather than preventing detection in other browsers. Nonstandard user-data directories and unknown unpacked extension IDs are not discovered automatically. For an unpacked extension, use the registration command shown in its side panel, which includes its extension ID, and select the browser explicitly if needed.

Channel targets are `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, and `chrome-for-testing`. On macOS/Linux each has a separate native-host directory. On Windows, Stable/Beta/Dev/Canary share Chrome's native-host registry key. Brave, Chromium, Arc, Chrome for Testing, Vivaldi, and Opera use the Chromium key before Chrome's fallback. Registering that primary key avoids a stale Chromium registration shadowing a repaired Chrome fallback. BBX tracks registered consumers so a scoped uninstall does not break the others.

For a browser started with `--user-data-dir`, use `bbx install --browser chrome-canary --user-data-dir "/absolute/path/to/browser-data"`. The path is the user-data root, not an individual profile. Exactly one explicit browser is required. The same options work with `--uninstall`. Browsers with fixed native-host directories retain those locations; Windows registration remains registry-based.

An explicit extension ID, supplied as an argument or through `BROWSER_BRIDGE_EXTENSION_ID`, selects browsers where that ID is found, or the platform's fallback browser if none is found. It replaces the selected host's allowlist unless `--preserve-origins` is passed, which retains existing IDs and adds the explicit ID. An exported empty `BROWSER_BRIDGE_EXTENSION_ID` is invalid; unset it to use the default. Plain `bbx uninstall` removes registrations for all supported browsers. The legacy `bbx install --uninstall` form keeps its single-browser default and honors `BBX_BROWSER` or `--browser`.

No Node.js, npm, or Go installation is needed to run these binaries. Return to the extension after registration. See the [quickstart](./quickstart.md) for agent setup.

## Versions and updates

The npm launcher downloads a stable native binary from a versioned GitHub
release and verifies its size, release checksum, and executable self-test.
Rerun `npm install -g @browserbridge/bbx@latest` to refresh that selection,
independently of the npm package version, then run `bbx restart`.

Set `BBX_VERSION` during installation to select an exact native version or
release line. Standalone installations can replace their binary with the
desired versioned release asset after verifying `checksums.txt`.

### Automatic native updates

Both npm and standalone binaries automatically discover stable versioned releases
in `koltyakov/browser-bridge` on GitHub. There is no separate update feed, signing
configuration, or renewal job.

The newest installed BBX extension across supported browser profiles selects the
`major.minor` line. For example, Chrome extension `2.2.1` and Edge extension `2.3.0`
select the newest stable `2.3.x` native binary, including patches newer than the
extension. Other release lines and prereleases are ignored. Updates never downgrade.
Different minor versions within the same major remain compatible while an update
is pending, unavailable, or disabled. The extension shows a non-blocking update
recommendation for an older native minor, using `bbx update` only if diagnostic
health advertises `nativeUpdateSupported: true`; otherwise it offers the native
installer script. It does not disable browser access merely for minor drift.
Registered extension manifests and native identity supply versions; stale extension
directories and disabled extensions do not raise the line. The newest observed
version is retained, so an older browser reconnect cannot lower it.

An extension update triggers an immediate check on native reconnect. While the
daemon runs, it wakes hourly and checks GitHub at most once every 24 hours, even
without an extension reconnect or an agent command. CLI/MCP startup can also check.
Periodic checks use the newest observed extension line, or the running binary's
line if no extension version is known. A newer extension bypasses the daily throttle.

Downloads use HTTPS to the fixed repository and GitHub's asset servers. Before
activation, BBX verifies the versioned release's `checksums.txt`, exact asset size,
and SHA-256 digest, then runs the executable self-test for its version and native
OS/architecture. This trusts GitHub repository ownership and TLS, not an independent
publisher signature. API, network, checksum, or probe failures keep the installed
selection unchanged.

Activation preserves the bootstrap executable and verified rollback payloads.
Automatic updates restart the daemon and native host and request MCP restarts from their owning
agents. No browser action is replayed. `bbx update status` reports the GitHub
source, selected line, and payload integrity. Explicit commands are `bbx update
check`, `apply`, `install`, `repair`, and `rollback`; plain `bbx rollback` still
rolls back browser patches.

Disable automatic updates with `bbx config set auto-update off` or
`BBX_AUTO_UPDATE=off`. Re-enable with `bbx config set auto-update compatible`.
Exact `BBX_VERSION=X.Y.Z` installation selectors remain pinned, including direct
MCP launches. Release-line selectors and the default latest selection permit
automatic updates. Remote destinations never update the local installation.

### Manual native updates

Run a manual update whenever needed:

```sh
bbx update
bbx restart
```

`bbx update` is shorthand for `bbx update apply`. It immediately checks GitHub
for the latest stable patch in the selected extension release line, verifies it,
and activates it. It bypasses the automatic daily throttle and works when
automatic updates are off, but still respects exact native version pins and
never downgrades. Run `bbx restart` afterward when the result reports
`restartRequired: true` so running bridge processes load the selected binary.

Use `bbx update check` to check without installing, and `bbx update status` to
inspect the selected binary. These commands need no enabled browser page and
operate only on the local installation.

### Keeping browser extensions aligned

When the daemon observes a newer extension in one browser/profile, it asks older
connected profiles with the same extension ID to check their browser store.
The extension calls `chrome.runtime.requestUpdateCheck()` at most once per day,
with the cooldown retained across native reconnects and worker restarts.
The daemon remembers observed versions while it runs, even if the newer
browser closes; a closed older browser can check when it connects again.

When a store update is available, the extension waits for local requests and
setup actions to become idle. It then asks the daemon to drain existing calls
and pause new dispatches to that profile. Only after the daemon grants reload
does the extension call `runtime.reload()`. Calls are not replayed. A canceled
or expired grant releases the drain so a failed update cannot block the profile
indefinitely.

This is best effort, not a bypass of browser update rules. Store rollouts,
throttling, policy restrictions, and missing updates still apply. An unexpected
major update is not force-applied based on evidence for another major.
Unpacked builds use their separate development reload path. Legacy extensions
without the update-check handler continue working but cannot be remotely
triggered this way; they need a normal browser/store update first.

### One-time upgrade for unconfigured installations

An existing binary reporting `configured: false` in `bbx update status` cannot
gain this updater from an extension update. This includes older builds expecting
an unconfigured signed feed. They need one manual native upgrade to a published
release containing the GitHub updater. Do not reinstall an older release and
expect the extension to supply the missing native code.

For npm, install a release containing this implementation with
`npm install -g @browserbridge/bbx@latest`, then run `bbx restart`. For standalone
installs, download that release's native OS/architecture asset, verify
`checksums.txt`, replace the installed binary, and run `bbx install` and
`bbx restart`. Restart older agents once if they predate coordinated MCP restart.
Confirm `bbx update status` shows `configured: true` and `source: "github"`.
Remove an exact native version pin through reinstalling with a release-line or
default selector if automatic updating is wanted.

Previously signed managed payloads remain subject to their original signature
checks; they are not silently accepted as GitHub checksum records. A fresh native
installation may be needed if an old managed selection cannot be verified.
These are migration instructions, not an automatic migration of existing machines.

## Scheduled mutations and verified flows

Scheduling-capable extensions advertise `mutationScheduling: true` in `health.ping.connectedExtensions`. The native daemon queues page-mutating operations per resolved tab, with at most 32 reservations per connection and 128 overall. The extension prepares the target before execution and rejects queued work if its document or access grant changes. Reads stay concurrent; cancellation retains a running slot until browser execution settles. Older components continue without scheduling, so update both components to use this protection.

`input.perform.outcomes` verifies final DOM/URL conditions and fresh top-document fetch/XHR response metadata in one call. It does not enable debugger network capture or fetch response bodies. An unverified sequence returns `OUTCOME_NOT_MET` and must not be automatically repeated. See the [interaction reference](../skills/browser-bridge/references/interaction.md#verify-outcomes-in-the-same-call) for the condition format and evidence limitations.

Bridge responses carry stage timing in `meta.timing`; compact CLI/MCP responses expose it as `timing` without zero phases or `scheduled: false`. `daemon.metrics.scheduler` reports preparing, queued, running, and canceling reservations. `daemon.metrics.timings` reports bounded process-lifetime histograms. `p50UpperBoundMs` and `p95UpperBoundMs` are bucket upper bounds, and execution includes transport. These metrics contain no page content or identifiers.

## Build from source

Go 1.27.3 or later is sufficient for an ordinary build:

```sh
go build ./cmd/bbx
go test -race ./...
```

Repository packaging and cross-language tests also use npm development dependencies:

```sh
make deps
make test-native
make package-native-all
make pack
```

Build all targets after tests so every release binary uses the current source and version. Packaging writes executables to `dist/cli` and prints their sizes. Each binary must be smaller than 12,000,000 bytes. The npm prepack step checks the six expected files directly and generates the manifest from their exact bytes. The manifest is generated output and must not be committed.

Native builds compress their embedded catalog and skill assets and omit Go's bundled HTTP/2 implementation to leave room for installed skill files within the fresh-install budget. Native update downloads use HTTPS over HTTP/1.1 with certificate and release-checksum verification. This does not change browser networking or the bridge's socket, TCP, native-messaging, or MCP transports.

The release workflow uploads and verifies all six native assets on the public `v<version>` GitHub release before publishing npm. It also packages the Chrome extension. See [publishing](./publishing.md) and the [native runtime README](../internal/bridge/README.md).

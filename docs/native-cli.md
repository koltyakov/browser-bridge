# Native CLI

Browser Bridge runs its CLI, native messaging host, daemon, MCP server, browser registration, and agent setup in one Go executable. The npm package downloads and launches that executable with zero runtime npm dependencies.

## Install through npm

Install the [Chrome extension](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie), then use Node.js 20 or later:

```sh
npm install -g @browserbridge/bbx
```

The wrapper selects macOS arm64/x64, Linux arm64/x64, or Windows x64. It downloads the exact npm package version from `https://github.com/koltyakov/browser-bridge/releases/download/v<version>/<asset>` and verifies the size and SHA-256 digest pinned in the package's `native-manifest.json`. There is no latest-version fallback.

A global npm install initializes browser registration. A local dependency install downloads the binary without registering a browser. If install scripts were skipped, the launcher fetches the binary on first use; run `bbx install` to register it. Source checkouts skip the npm bootstrap so development does not download a published runtime.

If the extension does not connect, run `bbx install`, or `bbx install --browser chrome` for Google Chrome on Linux. Choose your agent under **Connect agent** in the extension, then enable window access. See the [quickstart](./quickstart.md).

Node runs only the npm bootstrap and launcher. The downloaded Go executable runs without Node and contains the runtime metadata and agent skills it needs.

## Install without Node.js

Run the GitHub-hosted installer for your platform. On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.sh | sh
```

On Windows x64, run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.ps1 | iex
```

The installers download the latest release, verify its SHA-256 against the release's `checksums.txt`, install to `~/.local/bin`, register Chrome, and restart the daemon. Windows also adds the installation directory to your user `PATH`. Keep `~/.local/bin` on your shell's `PATH` on macOS and Linux.

After verifying the download, the installers try to remove an existing global `@browserbridge/bbx` npm package before installing the standalone CLI. If npm is unavailable, they skip this step. If detection or removal fails, they warn and continue without requesting elevated permissions.

The extension's setup panel provides a copyable command targeting its major-minor release line, such as `BBX_VERSION=2.0` or `-Version '2.0'`. The installer checks published GitHub releases and selects the highest stable `2.0.x` patch, excluding drafts and prereleases. It fails if no matching release is available rather than installing another release line. An exact version such as `2.0.3` is also supported. Without a version, it installs GitHub's latest release.

For an unpacked extension, set `BBX_EXTENSION_ID` for the Unix script or pass `-ExtensionId` to the PowerShell script. The Chrome Web Store ID is the default and is omitted from the setup command. Use `BBX_BROWSER` or `-Browser` for another supported browser, and `BBX_INSTALL_DIR` or `-InstallDir` for another installation directory. Run with `--help` or `-Help` for options.

### Download manually

Download a standalone executable from [GitHub Releases](https://github.com/koltyakov/browser-bridge/releases/latest). Choose the asset for your operating system and CPU:

| Platform | Asset |
| --- | --- |
| macOS, Apple silicon | `bbx-darwin-arm64` |
| macOS, Intel | `bbx-darwin-x64` |
| Linux, arm64 | `bbx-linux-arm64` |
| Linux, x64 | `bbx-linux-x64` |
| Windows, x64 | `bbx-windows-x64.exe` |

On macOS or Linux, replace `/path/to/downloaded-binary` below with the downloaded file's path:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 /path/to/downloaded-binary "$HOME/.local/bin/bbx"
export PATH="$HOME/.local/bin:$PATH"
bbx install
```

Keep `~/.local/bin` on your shell's `PATH` for future sessions. On Windows, rename the downloaded file to `bbx.exe`, place it in a permanent folder, add that folder to your user `PATH`, and run `bbx install` in a new terminal. You can also run `.\bbx.exe install` from that folder to register the browser before configuring `PATH`.

`bbx install` registers the native messaging host using the executable's location, so do not move or delete the binary afterward. On Linux, it targets Chromium by default; use `bbx install --browser chrome` for Google Chrome. For an unpacked extension, use the registration command shown in its side panel, which includes the extension ID.

No Node.js, npm, or Go installation is needed to run these binaries. Return to the extension after registration. See the [quickstart](./quickstart.md) for agent setup.

## Versions and updates

Update an npm-managed installation with `npm install -g @browserbridge/bbx@latest`, or specify an exact npm version. Published native assets are immutable; a rerun can reuse an identical asset but cannot replace it with different bytes.

For npm installations, `bbx update status` identifies npm as the version manager. Native self-update and forwarding to another native release are disabled, so commands and browser launchers keep using npm's exact version. Binaries live in a per-user, versioned cache outside `node_modules`, allowing npm upgrades while a Windows daemon is running.

Separately installed native executables support `bbx update` through a signed release feed and built-in trust keys. Publishing npm assets does not configure that feed. Retained cached versions and rollback payloads consume disk space in addition to the active executable.

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

Build all targets after tests so every release binary uses the current source and version. Packaging writes executables to `dist/cli` and prints their sizes. Each binary must be smaller than 10,000,000 bytes. The npm prepack step checks the five expected files directly and generates the manifest from their exact bytes. The manifest is generated output and must not be committed.

Native builds compress their embedded catalog and skill assets and omit Go's bundled HTTP/2 implementation to leave room for installed skill files within the fresh-install budget. Native update downloads use HTTPS over HTTP/1.1 with normal certificate and signature verification. This does not change browser networking or the bridge's socket, TCP, native-messaging, or MCP transports.

The release workflow uploads and verifies all five native assets on the public `v<version>` GitHub release before publishing npm. It also packages the Chrome extension. See [publishing](./publishing.md) and the [native runtime README](../internal/bridge/README.md).

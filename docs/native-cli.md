# Native CLI

Browser Bridge runs its CLI, native messaging host, daemon, MCP server, browser registration, and agent setup in one Go executable. The npm package downloads and launches that executable with zero runtime npm dependencies.

## Install through npm

Install the [Chrome extension](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie), then use Node.js 20 or later:

```sh
npm install -g @browserbridge/bbx
```

The wrapper selects macOS arm64/x64, Linux arm64/x64, or Windows x64. It downloads the exact npm package version from `https://github.com/koltyakov/browser-bridge/releases/download/v<version>/<asset>` and verifies the size and SHA-256 digest pinned in the package's `native-manifest.json`. There is no latest-version fallback.

A global npm install initializes browser registration. A local dependency install downloads the binary without registering a browser. If install scripts were skipped, the launcher fetches the binary on first use; run `bbx install` to register it. Source checkouts skip the npm bootstrap so development does not download a published runtime.

If the extension does not connect, run `bbx install`, or `bbx install --browser chrome` for Google Chrome on Linux. Choose your agent under **Connect your agent** in the extension, then enable window access. See the [quickstart](./quickstart.md).

Node runs only the npm bootstrap and launcher. The downloaded Go executable runs without Node and contains the runtime metadata and agent skills it needs.

## Versions and updates

Update an npm-managed installation with `npm install -g @browserbridge/bbx@latest`, or specify an exact npm version. Published native assets are immutable; a rerun can reuse an identical asset but cannot replace it with different bytes.

For npm installations, `bbx update status` identifies npm as the version manager. Native self-update and forwarding to another native release are disabled, so commands and browser launchers keep using npm's exact version. Binaries live in a per-user, versioned cache outside `node_modules`, allowing npm upgrades while a Windows daemon is running.

Separately installed native executables support `bbx update` through a signed release feed and built-in trust keys. Publishing npm assets does not configure that feed. Retained cached versions and rollback payloads consume disk space in addition to the active executable.

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

Build all targets after tests, because native tests can replace the size report with a host-only build. Packaging writes executables and a versioned `size-report.json` to `dist/cli`. Each binary must be smaller than 10,000,000 bytes. The npm prepack step validates all five targets and generates the manifest from their exact bytes. The manifest is generated output and must not be committed.

The release workflow uploads and verifies all five native assets on the public `v<version>` GitHub release before publishing npm. It also packages the Chrome extension. See [publishing](./publishing.md) and the [native runtime README](../internal/bridge/README.md).

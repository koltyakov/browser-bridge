# Native runtime

This Go runtime implements the agent CLI, native messaging host, daemon, MCP server, installation, and agent setup. The root module is `github.com/koltyakov/browser-bridge`; `cmd/bbx` is the executable entrypoint. The npm package is a bootstrap and launcher with zero runtime npm dependencies. It downloads the exact package version's native asset and verifies the SHA-256 digest pinned in its manifest.

## Build and verify

Go 1.27.3 or later is sufficient for an ordinary build. CI uses the version declared in the root `go.mod`. Protocol bindings, runtime metadata, and skill assets are checked in, so neither building nor running the executable requires a JavaScript runtime.

```sh
go build ./cmd/bbx
go test -race ./...
go vet ./...
```

Repository packaging and cross-language checks also use the npm development dependencies:

```sh
make check-protocol
make package-native
make package-native-all
make test-native
```

Change `protocol/types.ts` for wire type changes and `protocol/mcp-tools.json` for MCP tool metadata, then run `make generate-protocol`. The same target updates Go bindings, JSON Schema, runtime metadata, and embedded skills. Shared JavaScript helpers under `protocol/src/` serve the browser and build tooling. See [the shared protocol guide](../../protocol/README.md).

Release binaries go to `dist/cli`. The build rejects executables at or above **10,000,000 bytes** and writes `size-report.json` with the resolved version on every entry. Local builds derive it from `manifest.json`; release pipelines derive it from the Git tag. The build uses `CGO_ENABLED=0`, strips debug information, and disables compiler inlining with `-gcflags=all=-l` to reduce executable size. Ordinary `go build` retains Go's default optimization settings and uses the checked-in catalog version. Interop tests use the repository's TypeScript/Node test runner.

Build sizes are recorded in `dist/cli/size-report.json`. The budget applies to each executable. Installed agent files, update payloads, and rollback copies also consume disk space and must be measured separately.

Measured with Go 1.27.3 and the packaging flags above:

| Target | Executable bytes |
| --- | ---: |
| macOS arm64 | 8,491,874 |
| macOS x64 | 9,253,696 |
| Linux arm64 | 8,323,232 |
| Linux x64 | 9,064,608 |
| Windows x64 | 9,439,232 |

`tests/native/install.test.ts` checks the fresh executable plus one agent's MCP/skill installation against the 10 MB budget with Node absent from `PATH`. It also exercises all-agent setup. Each additional agent receives its own editable skill files.

## Implemented

- JSON-lines client with existing agent credentials, concurrent response correlation, bounded frames, cancellation, and no automatic mutation retries.
- CLI shortcuts, raw calls, read-only batches, summaries, file transfers, screenshots/HAR, recording and replay, configuration, doctor, and restart. Explicit browser/profile/connection/tab targeting and budget presets are supported.
- Native messaging relay with little-endian framing, separate extension credentials, control-message translation, daemon bootstrap, and shutdown propagation.
- Daemon socket/TCP/named-pipe listeners, authentication, profile routing, quotas, artifacts, durable journals, baseline ownership, window actions, setup services, and recovery telemetry. Request IDs are scoped to their agent connection.
- Native registration for Chrome, Edge, Brave, Chromium, and Arc; MCP configuration and embedded skills for all eight supported agents. Install/uninstall preserves unrelated settings and locally modified skill files.
- Remote destinations and authenticated proxy listeners.
- MCP legacy progressive tools and modern stateless tools, generated schemas, discovery, subscriptions, cancellation, image/artifact delivery, and native Readability extraction. Each MCP process retains its agent connection; raw calls are not retried.
- Signed native update verification, bounded downloads, compatible-version selection, atomic activation, repair, and rollback. Production use requires a release feed and trust keys.
- Go tests own runtime behavior. TypeScript tests in `tests/integration/` and `tests/native/` exercise real Go CLI, daemon, native-host, and MCP processes against wire fixtures and simulated extension peers.

## npm release packaging

After tests, `make package-native-all` builds the five supported targets. `scripts/prepare-npm.mjs` requires a complete current-version report, validates each file and its size, then atomically generates `packages/npm/native-manifest.json`. It pins asset names, sizes, and SHA-256 digests for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `win32-x64`. Do not commit generated hashes.

The release workflow publishes and verifies these assets on the public GitHub `v<version>` release before npm publication. Existing assets must match exactly; publishing never overwrites them. The npm tarball contains only the launcher, bootstrap, generated manifest, and package metadata/license/docs. It does not export a JavaScript client library.

Global npm installation downloads the matching binary and initializes native messaging registration. Local dependency installation does not register browsers, and source checkouts skip bootstrap. If install scripts were skipped, the launcher downloads on first use and the user runs `bbx install` explicitly. See [publishing](../../docs/publishing.md).

Use isolated `BROWSER_BRIDGE_HOME` and `BBX_TCP_PORT` values when testing a daemon. Continue testing packaged installation, upgrades, repair, and rollback on every supported OS; cross-compilation does not verify platform behavior.

## Native updates

For npm installations, `bbx update status` reports `distribution: "npm"`; npm controls the runtime version. The wrapper and generated browser launchers carry `BBX_NPM_VERSION`, which prevents native update forwarding or self-update from replacing npm's selection.

For separately installed native executables, `bbx update status` reports whether signed updates are configured. Management commands are `update check`, `update apply`, `update install`, `update repair`, and `update rollback`. The existing `bbx rollback` command still rolls back browser patches.

Native signed updates are separate from npm's pinned GitHub release downloads. Builds that enable native updates must pin `internal/bridge.nativeUpdateFeedURL` and `internal/bridge.nativeUpdateKeysJSON` through Go linker flags, using the full module import path. The latter is a JSON object mapping key IDs to base64 Ed25519 public keys. Environment variables and runtime configuration cannot replace those trust keys. Publishing npm assets alone does not enable the signed updater.

The HTTPS feed is an envelope with `signed`, the base64-encoded manifest bytes, and `signatures`, an array of `{keyId, signature}` objects. Each signature covers the exact decoded manifest bytes. The manifest includes `schemaVersion: 1`, `channel: "stable"`, an increasing `sequence`, `issuedAt`, `expiresAt`, and `releases`. Releases contain `version`, `protocolMajor`, and `artifacts` keyed by `go-<os>-<arch>`, each with HTTPS `url`, `sha256`, and `size`.

The updater verifies metadata, downloads into an immutable version directory, probes the executable, and atomically selects it. It preserves the original executable and authenticated rollback payloads, including on Windows. Retained versions can make update disk usage exceed the single-executable budget.

The existing `bbx config set auto-update compatible` policy enables a throttled update check before CLI browser commands or an MCP session starts. It uses authenticated local extension health and compatible protocol versions. A successful update restarts the local daemon and starts the selected executable before dispatching browser work. Remote destinations do not update the local installation.

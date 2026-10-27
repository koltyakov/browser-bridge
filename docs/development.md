# Development

Run repository tasks through the root `Makefile`. `make` or `make help` lists the targets.

## Prerequisites

- GNU Make 3.81 or later. macOS includes it with Xcode Command Line Tools; install `make` with your package manager on Linux. On Windows, install it with `choco install make --yes` and ensure `make` is on `PATH`.
- Node.js 20 or later and npm for extension builds, TypeScript tests, protocol generation, and packaging.
- The Go version declared in `go.mod` for native builds and tests.
- Chrome or Chromium for the optional real-browser tests.

```sh
make deps
make build
make check
```

`make deps` installs the lockfile with `npm ci`. Use `npm install` when intentionally changing dependencies.

The Go runtime lives in `cmd/bbx` and `internal/bridge`; its unit tests live beside the Go source. `packages/` contains only the TypeScript extension and zero-runtime-dependency npm launcher. Shared definitions and browser/build helpers live in `protocol/`. TypeScript tests cover the extension, protocol, npm launcher, and real Go process flows under `tests/integration/` and `tests/native/`.

`manifest.json.version` is the local version source. Build targets synchronize npm metadata from it and regenerate the native catalog. Release pipelines override the checkout version with the Git tag. `make sync-version` updates version mirrors without building; `make check-release-version` verifies them. A direct `go build ./cmd/bbx` uses the checked-in catalog and needs no Node tooling.

### Registry ownership

- `internal/bridge/agents_registry.go` owns supported agents and their setup/detection behavior.
- `internal/bridge/cli_registry.go` owns command metadata, shortcut parsers, help, targeting, and output policy. Command handlers still own execution.
- `protocol/install-targets.json` owns native platforms, browser installation paths, asset names, the binary-size limit, and published extension/native-host identities. `make generate-protocol` updates all generated consumers, including marked installer and CI blocks.
- `protocol/src/defaults.ts` owns shared numeric limits; `protocol/src/errors.ts` owns default error recovery. Generated Go limits and the catalog carry those policies into the native runtime.

Do not add parallel command, platform, or browser lists. `make check-protocol` rejects stale generated consumers. Add behavioral tests alongside registry contract tests; metadata agreement alone does not verify dispatch or cleanup.

Setup filesystem work is serialized separately from daemon routing and admitted through a bounded queue. Tab-resource cleanup runs each registered hook even after another resource fails, then reports the collected failures.

## Common tasks

| Command | Result |
| --- | --- |
| `make build-extension` | Unpacked extension with source maps in `dist/ext` |
| `make build-native` | Local Go executable at `dist/cli/bbx`, or `dist/cli/bbx.exe` on Windows |
| `make install` | Build both components, install the CLI to the user bin directory, refresh native registration, and restart the runtime |
| `make lint typecheck` | JavaScript/TypeScript and Go lint, formatting, and TypeScript type checks |
| `make lint-go` | Go formatting and pinned golangci-lint |
| `make lint-js` | JavaScript/TypeScript lint and formatting |
| `make format` | Format JavaScript, TypeScript, configuration, and Go |
| `make test` | Go race tests, then Node tests with coverage |
| `make test-runtime` | Node tests without coverage |
| `make test-native` | Go race tests and native cross-language tests |
| `make coverage-go` | Go unit-test statement coverage by function |
| `make coverage-go-check` | Check Go runtime and protocol unit-coverage baselines |
| `make check` | Version/protocol checks, lint, typechecking, Go formatting/vet, tests, and coverage thresholds |
| `make generate-protocol` | Regenerate shared wire types, schemas, catalog, and skills |
| `make sync-version` | Synchronize npm metadata from the manifest or release tag |
| `make package-extension` | Release extension ZIP without source maps |
| `make package-native TARGET=linux-amd64` | Size-checked native release for one platform |
| `make package-native-all` | All five native release targets in `dist/cli` |
| `make package-npm` | Build all native targets and pack the thin npm wrapper |
| `make release-check` | Full validation and release packaging without publishing |

Targets run serially even with `make -j`: tests and packaging share output directories. Release checks build all native assets after tests and before npm packing.

`make lint-go` runs golangci-lint through `go run` at the version pinned in `Makefile`. No separate installation is required. CI and release validation run it through `make lint`.

The default linters check errors, vet diagnostics, static analysis, and unused code. `.golangci.yml` keeps Staticcheck's default checks except `ST1005`, since existing user-facing error messages preserve CLI wording, usage text, and product names.

## Install a checkout

```sh
make install
# Optional destination override:
make install INSTALL_DIR="$HOME/.local/bin"
```

This regenerates protocol metadata, builds the unpacked extension in `dist/ext`, and installs one Go executable plus lightweight command aliases under `~/.local/bin`. Native-host manifests point to the installed executable. Keep that directory on your application's `PATH` when using `bbx` or `bbx-mcp` by name.

Installation restarts the local daemon. Connected native hosts exit and Chrome reconnects them through the updated launcher. Registered MCP servers receive restart requests; their owning applications must reconnect their stdio sessions.

Load `dist/ext` once through `chrome://extensions` with Developer mode enabled. Development builds check their build stamp on native-host reconnect and every minute. All profiles loading that same directory reload when the completed build changes. An extension version predating this feature needs one manual reload to enable it. Release ZIPs do not include this automatic development reload behavior.

Development builds display a content-based suffix, such as `v2.0.0-dev.a1b2c3d4`, in the popup and side-panel version tooltips. Hover or focus the info icon at the top-right of the access card to see the extension and daemon versions. `bbx --version` also includes the suffix for a CLI built with `make build-native` or `make install`; `make run ARGS='--version'` shows the workspace CLI label. The CLI hash covers native sources and embedded assets, so it differs from the extension hash. Each suffix changes when its build inputs change; rebuilding identical inputs keeps the same label. Release builds display the plain version, and update checks continue to use the base version.

Recent activity and enabled-window access survive extension updates and development reloads. Each tab keeps its bounded history until the tab closes or Chrome starts a new browser session. Access is restored only for the same open window; disabling access, closing that window, or restarting Chrome clears the saved grant.

## Focused tests and local tools

```sh
make test-runtime TEST_FILES=packages/extension/test/page-recorder.test.ts
make test-runtime TEST_FILES=packages/extension/test/background-files.test.ts TEST_ARGS='--test-name-pattern=staging'
make fixture-browser ARGS='--port 4317'
make run ARGS='call health.ping'
make bench-runtime
```

`test-js` and `test-runtime` build the extension and Go executable before testing. `test-js` replaces the coverage results, so use `test-runtime` for focused runs when retaining full-suite coverage. Set `BBX_TEST_CHROME` to your browser executable to include the real-Chrome tests.

`make test-go` writes race-enabled unit-test coverage to `dist/coverage/go-unit.out`, separately from c8. `make check` and CI enforce a 68% statement baseline for `internal/bridge` and 85% for `internal/protocol`. These percentages exclude separately launched integration binaries and the CLI entry point. Use the Go report to target uncovered error and lifecycle paths rather than relying on the JS/TS coverage total.

`make status` and `make daemon` run the workspace Go CLI. `make install-manifest ARGS='<extension-id>'` registers the persistent executable produced by `make build-native`.

`package.json` contains only `build:extension`, `package:extension`, `postinstall`, and `prepack`. These run Node directly. Use Make for testing, linting, fixtures, native builds, and release validation. Run `make prepublish-check` before a manual publication from the checkout; npm no longer runs it as a lifecycle hook. See [publishing](./publishing.md) for release order and authentication.

## Request lifetime and storage ordering

The daemon advertises request cancellation during registration and overwrites routed deadlines and artifact-acknowledgement metadata. Timeout policies live in `protocol/src/operation-timeouts.ts` and are generated into the native catalog. Keep approval waits and callback execution in the same transport budget.

Cancellation stops queued work and later steps, including content-side auto-waits. It cannot undo a mutation already dispatched to Chrome. Treat a timed-out mutation as uncertain and inspect its postconditions rather than replaying it automatically.

Production artifact and journal disk operations run on a bounded, ordered storage executor, outside `daemon.mu`. Artifact acknowledgements follow validation and disk writes. Cleanup has reserved queue capacity, and artifact responses wait behind their commits. Legacy extensions receive per-connection read backpressure. New extensions talking to an older daemon yield between chunks instead of waiting for unsupported acknowledgements.

`make bench-runtime` measures daemon health-request routing with its storage worker deliberately blocked. It does not measure Chrome round-trip latency. The stability regression tests also cover dialog-blocked teardown, iframe patch rollback, oversized errors, cancellation, and concurrent lease persistence.

`make bench-interaction ARGS='--runs=5'` measures real-Chrome interaction scenarios through MCP. It requires exactly one enabled browser profile, opens its fixture in a background tab, and closes that tab afterward. Every scenario starts with fresh fixture state. Reported action calls, approximate output tokens, and elapsed time exclude fixture setup and ground-truth verification; JSON rows report verification costs separately. Repeated runs report per-scenario success counts and p50/p95 latency for successful actions. These scripted scenarios test bridge execution, not model planning time or real-agent task success.

### Public-site workflow tests

`make test-workflows-live` runs opt-in, mutating workflows on httpbin's echo form, Playwright's TodoMVC demo, and The Internet's delayed controls. Enable one browser window and select its exact profile label from `health.ping.connectedExtensions`:

```sh
BBX_LIVE_PROFILE_LABEL='<profileLabel>' make test-workflows-live
```

The runner waits for the workspace extension build before mutating pages. It opens background tabs, submits synthetic form data only to an echo endpoint, and removes only its uniquely named todos. It tests independent MCP working tabs, cross-tab read batches, partial sequence failures, inline React editing, delayed enablement, stale refs after remounting, DOM/visual baselines, desktop/mobile/reset, and closing a working tab. It never navigates, resizes, activates, or closes a pre-existing tab.

Timing and bounded failure evidence go to `dist/workflows-live/metrics.json`. These tests require internet access and are excluded from `make test`; public-site changes and network failures need separate diagnosis from bridge regressions.

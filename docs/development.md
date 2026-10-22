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

## Common tasks

| Command | Result |
| --- | --- |
| `make build-extension` | Unpacked extension with source maps in `dist/ext` |
| `make build-native` | Local Go executable at `dist/cli/bbx`, or `dist/cli/bbx.exe` on Windows |
| `make install` | Build both components, install the CLI to the user bin directory, refresh native registration, and restart the runtime |
| `make lint typecheck` | JavaScript/TypeScript lint, formatting, and type checks |
| `make format` | Format JavaScript, TypeScript, configuration, and Go |
| `make test` | Go race tests, then Node tests with coverage |
| `make test-runtime` | Node tests without coverage |
| `make test-native` | Go race tests and native cross-language tests |
| `make check` | Version/protocol checks, lint, typechecking, Go formatting/vet, tests, and coverage thresholds |
| `make generate-protocol` | Regenerate shared wire types, schemas, catalog, and skills |
| `make sync-version` | Synchronize npm metadata from the manifest or release tag |
| `make package-extension` | Release extension ZIP without source maps |
| `make package-native TARGET=linux-amd64` | Size-checked native release for one platform |
| `make package-native-all` | All five native release targets in `dist/cli` |
| `make package-npm` | Build all native targets and pack the thin npm wrapper |
| `make release-check` | Full validation and release packaging without publishing |

Targets run serially even with `make -j`: tests and packaging share output directories. Release checks build all native assets after tests and before npm packing.

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
```

`test-js` and `test-runtime` build the extension and Go executable before testing. `test-js` replaces the coverage results, so use `test-runtime` for focused runs when retaining full-suite coverage. Set `BBX_TEST_CHROME` to your browser executable to include the real-Chrome tests.

`make status` and `make daemon` run the workspace Go CLI. `make install-manifest ARGS='<extension-id>'` registers the persistent executable produced by `make build-native`.

`package.json` contains only `build:extension`, `package:extension`, `postinstall`, and `prepack`. These run Node directly. Use Make for testing, linting, fixtures, native builds, and release validation. Run `make prepublish-check` before a manual publication from the checkout; npm no longer runs it as a lifecycle hook. See [publishing](./publishing.md) for release order and authentication.

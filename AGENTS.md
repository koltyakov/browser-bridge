# Project Guide

## Overview

`Browser Bridge` is a Chrome extension plus local Native Messaging bridge for token-efficient, scoped browser inspection and patching.

### Data Flow

```
Agent/IDE ──stdio──▶ Go MCP Server ──▶ Go client ── JSON-lines over TCP/socket ──▶ Go daemon
bbx Go CLI ─────────────────────────▶ Go client ── JSON-lines over TCP/socket ────┘

Extension Background ── Chrome Native Messaging ──▶ Native Host (relay) ── TCP/socket ──▶ Daemon
(Service Worker) ───── chrome.tabs.sendMessage ───▶ Content Script ───────▶ Browser DOM
                 ├──── chrome.debugger (CDP)
                 └──── chrome.scripting (MAIN world) ─────────────────────▶ Element/patch registries
```

**Outbound:** Agent calls MCP tool → Go client sends `{ type: 'agent.request', request }` as JSON-lines over TCP/socket → Daemon routes to extension socket → Native host relays to Chrome native messaging → Background service worker dispatches to content script or handles directly.

**Inbound:** Content script returns result → Background wraps into `createSuccess`/`createFailure` → Native host relays to daemon → Daemon matches pending request → `{ type: 'agent.response', response }` back to agent socket.

Two transport segments:
- **Agent ↔ Daemon**: Unix domain socket, TCP (default Windows endpoint `127.0.0.1:9223`), or Windows named pipe for an isolated bridge home; newline-delimited JSON.
- **Extension ↔ Daemon**: Chrome Native Messaging (4-byte LE length-prefixed binary) over stdio, relayed by the native-host subprocess.

### Package Map

The runtime is a root Go module (`go.mod`). `cmd/bbx` is its executable; `internal/bridge` implements the CLI, native host, daemon, MCP server, and local setup services. Only the extension and npm launcher live under `packages/`. The published npm module is a bootstrap and launcher under `packages/npm`, with zero runtime npm dependencies. It does not export a JavaScript client library.

`protocol/types.ts` is the canonical wire type source; `protocol/mcp-tools.json` owns MCP tool metadata. `make generate-protocol` generates Go bindings, JSON Schema, the native runtime catalog, and embedded skills. Generated files are checked in and verified with `make check-protocol`; do not edit them by hand. Shared JavaScript helpers under `protocol/src/` support the browser and build tooling, not a second runtime.

| Package | Entry | Responsibility |
|---|---|---|
| `cmd/bbx/` | `main.go` | Single Go executable for CLI, native host, daemon, and MCP modes. |
| `internal/bridge/` | `main.go` | Native implementation of the npm-distributed runtime and setup services. |
| `packages/npm/` | `bin/`, `src/` | npm bootstrap and launchers; downloads the exact package version/platform Go binary and verifies its pinned digest. |
| `protocol/` | `types.ts`, `src/`, `mcp-tools.json` | Canonical wire types, method and MCP metadata, browser/build helpers, fixtures, and generated JSON Schema. Go bindings live in `internal/protocol/`. |
| `packages/extension/` | `src/background.ts` | MV3 service worker - native port, request dispatch, state management. `src/content-script.ts` handles all DOM operations. TypeScript compiles to browser JavaScript under `dist/ext`. |
| `tests/integration/` | `*.test.ts` | Real-process integration tests against the Go runtime. |

### Where to Find Things

**Protocol concerns**:
- Wire types & method shapes: `protocol/types.ts`
- Method registry: `protocol/src/registry.js`
- MCP tool metadata: `protocol/mcp-tools.json`
- Error codes & browser/build `BridgeError`: `protocol/src/errors.js`
- Defaults & budget presets: `protocol/src/defaults.js`
- Browser/build request/response helpers: `protocol/src/protocol.js`

**Daemon internals**:
- Daemon and routing: `internal/bridge/daemon.go`
- Native messaging relay: `internal/bridge/native.go`
- Socket path and credentials: `internal/bridge/config.go`
- Wire framing: `internal/bridge/wire.go`

**Extension internals**:
- Main service worker: `packages/extension/src/background.ts`
- Bridge request validation: `packages/extension/src/background-bridge.ts`
- Tab resolution & routing: `packages/extension/src/background-routing.ts`
- Access/window management: `packages/extension/src/background-access.ts`
- CDP coordinator: `packages/extension/src/debugger-coordinator.ts`
- Content script (DOM ops): `packages/extension/src/content-script.ts`
- Content script helpers: `packages/extension/src/content-script-helpers.ts`

**CLI and agent setup**:
- Transport client: `internal/bridge/client.go`
- CLI entry point and dispatch: `cmd/bbx/main.go`, `internal/bridge/main.go`
- CLI shortcuts: `internal/bridge/cli_shortcuts.go`
- Skill install logic and paths: `internal/bridge/agents_skills.go`
- Agent names and MCP config generation: `internal/bridge/agents_config.go`

**MCP server**:
- Tool schemas and instructions: `protocol/mcp-tools.json`
- MCP server and transport: `internal/bridge/mcp.go`, `internal/bridge/mcp_transport.go`
- Handler dispatch: `internal/bridge/mcp_handlers.go`
- Discovery and subscriptions: `internal/bridge/mcp_discovery.go`, `internal/bridge/mcp_subscriptions.go`

### Method Dispatch (Extension Side)

The extension's `dispatchBridgeRequest()` handles methods by category:

- **System** (background handles directly): `health.ping`, `access.request`, `skill.get_runtime_context`
- **Tabs** (delegated to `background-tabs.ts`): `tabs.list`, `tabs.create`, `tabs.close`
- **Page-level** (CDP or MAIN-world scripting): `page.evaluate`, `page.get_console`, `page.get_network`
- **Tab-bound** (forwarded to content script): `dom.*`, `styles.*`, `layout.*`, `input.*`, `patch.*`, `viewport.scroll`, `page.get_state/storage/text`, `screenshot.*`
- **CDP** (via `chrome.debugger`): `cdp.*`, `viewport.resize`, `dom.get_accessibility_tree`
- **Navigation** (via `chrome.tabs` API): `navigation.*`

The daemon handles some methods locally without forwarding: `health.ping` (no extension), `log.tail`, `daemon.metrics`, `setup.*`.

## CLI Quick Reference

```bash
bbx status                          # bridge health
bbx doctor                          # install/access readiness
bbx install [extension-id]          # install native manifest
bbx call <method> '{"key":"val"}'   # any RPC method
bbx batch '[{...}]'                 # parallel reads
bbx install-mcp [client]            # write MCP config (all clients if omitted)
bbx skill                           # runtime presets
bbx proxy <enable|disable|status>   # opt-in TCP proxy mode on the browser machine
bbx remote <add|list|test|remove>   # manage remote destinations; any bridge command accepts --remote <name> (or BBX_REMOTE env)
```

Also: `bbx-daemon` (start daemon), `bbx-install <ext-id>` (install manifest directly), `bbx-mcp` (start MCP server directly).

For agent debugging inside this repo, use `make run ARGS='call health.ping'` to exercise the workspace Go CLI. Keep end-user documentation, the shipped skill, and consumer-facing guidance using `bbx`, `bbx-daemon`, and `bbx-install` as globally installed commands.

## Development Commands

The root Makefile is the primary task runner for development and CI. Run `make` for help. GNU Make is required for repository tasks; published npm installation hooks remain independent of Make. Keep task orchestration in Make. Limit npm scripts to extension build/package commands and wrapper lifecycle hooks; do not add Make aliases to package.json. See `docs/development.md` for prerequisites and options.

```bash
make deps                      # install locked development dependencies
make lint                      # oxlint + oxfmt check
make format                    # format JavaScript, TypeScript, and Go
make typecheck                 # tsc --noEmit
make test                      # Go race tests + Node tests with c8 coverage
make coverage-check            # verify 92% lines / 83% branches
make check                     # all source checks, tests, and coverage
make build-extension           # compile unpacked extension with source maps
make install                   # build both components, install to ~/.local/bin, and restart runtime
make package-extension         # build extension ZIP for CWS
make package-native-all        # build all five native release targets
make package-npm               # build all native targets and pack the thin npm launcher
make release-check             # full pre-release validation and packaging

make run ARGS='call health.ping' # exercise the workspace Go CLI
make daemon                    # start daemon locally
```

## Skill Structure

- `skills/browser-bridge/SKILL.md` - core rules, quick reference, access flow (always loaded)
- `skills/browser-bridge/references/protocol.md` - full method table, error codes (load when exploring methods)
- `skills/browser-bridge/references/token-efficiency.md` - budget presets, anti-patterns (load when optimizing)
- `skills/browser-bridge/references/patch-workflow.md` - style/DOM patch loops (load when patching)
- `skills/browser-bridge/references/interaction.md` - input, navigation, form controls (load when interacting)

## Working Rules

- **JavaScript ESM only** - `"type": "module"` in root package.json. JavaScript modules use `import`/`export`; injected extension scripts follow the classic-script rules below.
- **Build output** - unpacked extension files go in `dist/ext`; local and release Go executables go in `dist/cli`. Extension ZIPs stay directly under `dist/`.
- **Development installation** - `make install` regenerates metadata, builds both components, and runs the Go self-installer. Keep one executable in the user bin directory with lightweight aliases. Development extension builds detect completed on-disk builds on native reconnect and periodic alarms; release ZIPs must disable this behavior.
- **Extension TypeScript build** - author extension background, content, and UI code in `.ts` with native type annotations. `make build-extension` uses esbuild to emit browser JavaScript at the existing manifest paths in `dist/ext`, with source maps for development. `make package-extension` compiles a release ZIP without TypeScript sources or source maps. npm launchers run directly from JavaScript source. Build Go from the root with `make build-native`.
- **TypeScript tests use Node built-in runner** - `node --test`, not Jest/Mocha. These tests must be TypeScript (`*.test.ts`) and cover the extension, protocol, npm launcher, and real-process integration. Integration tests live in `tests/integration/`; native cross-language tests live in `tests/native/`. Runtime unit tests belong beside the Go implementation.
- **Go tests use the standard testing package** - `*_test.go` beside implementation files. Run `make test-go vet-go` from the root. Shared wire fixtures live in `protocol/fixtures/`.
- **Linting** - `oxlint` (Rust-based), formatting with `oxfmt`. 2-space indent, single quotes, semicolons, trailing commas.
- **Node >= 20** - no Node 22+ only APIs.
- Do not use the `any` type in source or tests. Use `unknown`, explicit narrowing, discriminated unions, or protocol/domain types instead.
- Preserve the generic protocol shape. Do not add task-specific bridge commands for one-off actions when an existing RPC method can express the action.
- Prefer improving the shared protocol, client ergonomics, or skill/docs over introducing special-case commands.
- Keep the bridge token-efficient. Favor structured DOM/style data over screenshots or raw HTML dumps.
- Treat extension content scripts as classic scripts. Keep their IIFEs and injection order; do not add runtime ESM imports or exports. Injected functions must remain self-contained after compilation because Chrome serializes them. Keep manifest, HTML, and runtime injection paths ending in `.js`; source imports may use `.js` specifiers resolved to `.ts` by TypeScript.
- Keep native-host startup robust for GUI launch contexts. Do not assume shell-specific `PATH` resolution.
- Treat the top-level `README.md` as npm-facing documentation. When adding or editing links or image references there, prefer absolute GitHub URLs instead of relative paths so the npm package page renders them correctly.

## Typing Standards

- Canonical wire types live in `protocol/types.ts`; browser-specific reusable types belong in TypeScript modules. Runtime implementation types belong in Go.
- Extension source is TypeScript. npm launchers and shared browser/build JavaScript helpers must remain strongly typed with `// @ts-check` and complete JSDoc.
- Raw `.js` source files must always include JSDoc typings.
- Start raw JS modules with `// @ts-check`.
- Add JSDoc typedefs and annotations for exported functions, key internal helpers, parameters, return values, and non-obvious structured data.
- Do not omit types for new or changed logic. Newly added raw JS logic must not be left untyped.
- Do not introduce `any` in TypeScript or JSDoc annotations.
- Run `make typecheck` after changing JS sources.
- Go source must use generated protocol types where applicable. Format Go with `gofmt`; use `json.RawMessage` for arbitrary wire values instead of decoding through floating-point interface maps.

## Validation

- Run `make typecheck`.
- Run `make test`.
- `make test-js` and `make test-runtime` build the extension first. Browser, UI, background-loading, and serialized-function tests use the emitted JavaScript via `tests/_helpers/extensionBuild.ts`. Run `make build-extension` before invoking those tests directly.
- Run `make lint` to check code style and formatting.
- **After AI edits to code or tests**: Always run `make lint`, `make typecheck`, and `make test` to ensure changes don't break existing functionality.
- **After AI edits that do not touch code or tests**: Run `make lint`; `make typecheck` and `make test` are not required unless the change could affect runtime behavior.
- When touching the extension/browser protocol path, verify at least one live CLI flow against Chrome if possible.

## Agent Support Maintenance

When adding or modifying agent/editor support (e.g., adding a new IDE or agent client):

1. **Alignment requirement**: Agent support must be kept consistent across:
   - Code base: `internal/bridge/agents_config.go` (`installAgentNames`, `installAgentLabels`, MCP config shapes and paths)
   - Code base: `internal/bridge/agents_skills.go` (`installSkillBase`, skill installation)
   - Documentation: `README.md` (text descriptions, example commands)
   - Documentation: `docs/quickstart.md` (supported clients list, example commands)
   - Extension UI: Side panel settings and host setup UI

2. **Order preservation**: Maintain the same agent order across all locations. Current order:
   - codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents

3. **README.md table restriction**: The "Supported Agents" table in `README.md` is **manually maintained** and should NOT be modified by AI agents. Only update text descriptions and example commands in README.md, not the visual table layout.

4. **When adding a new agent**:
   - Add to `installAgentNames` and `installAgentLabels` in `internal/bridge/agents_config.go`
   - Add MCP config handling to `installMCPKey` and `installMCPEntry`
   - Add global and local config paths to `installMCPPath`; update `installMCPPaths` for clients with multiple config locations
   - Add global and local skill paths to `installSkillBase` in `internal/bridge/agents_skills.go`
   - Update Go installation tests and regenerate embedded skills after changing skill sources
   - Update text descriptions in README.md and `docs/quickstart.md`
   - Update example commands in `docs/quickstart.md`
   - Do NOT modify the Supported Agents table in README.md

## CLI and Protocol Expectations

- `package.json` registers the `packages/npm/bin` launchers as `bbx`, `bbx-daemon`, `bbx-install`, and `bbx-mcp`; they delegate to the Go binary.
- `package.json` uses the publish name `@browserbridge/bbx`.
- `manifest.json.version` is the local version source; release pipelines use the `vX.Y.Z` Git tag instead. `scripts/version.mjs` resolves this authority and `make sync-version` updates npm version mirrors. Never independently bump `package.json` or `package-lock.json`. Release builds synchronize metadata and regenerate the native catalog before validation.
- Published runtime files are limited to `packages/npm/bin`, `packages/npm/src`, and generated `packages/npm/native-manifest.json`, plus package metadata/license/docs. npm has zero runtime dependencies; browser/build dependencies stay development-only.
- npm global postinstall downloads the exact matching Go release and initializes native registration. Local dependency installs must not register browsers; source checkout installs skip bootstrap. Skipped scripts use lazy fetch followed by explicit `bbx install`.
- Build all native targets for the current version after tests before packing. `scripts/prepare-npm.mjs` validates sizes and hashes the five expected binaries directly under `dist/cli`; never commit generated manifest hashes.
- Native GitHub release assets must be public and verified before npm publish. Never overwrite a published binary with different bytes. npm's pinned assets are independent of the native signed-update feed.
- `npm link` from this repo exposes `bbx`, `bbx-mcp`, `bbx-daemon`, and `bbx-install` machine-wide for consumer repos.
- When working from this repository for debugging, use `make run ARGS='...'` for the workspace Go CLI.
- Do not rewrite end-user docs or skill guidance to `npx`; published instructions should continue to assume the CLI is globally installed and invoked as `bbx`.
- Prefer the generic `call` path for arbitrary bridge methods.
- High-level helper commands are acceptable only when they map cleanly onto shared protocol methods and do not narrow the protocol surface.

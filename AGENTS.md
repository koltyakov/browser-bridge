# Project Guide

## Overview

`Browser Bridge` is a Chrome extension plus local Native Messaging bridge for token-efficient, scoped browser inspection and patching.

### Data Flow

```
Agent/IDE ──stdio──▶ MCP Server ──▶ BridgeClient ──TCP/socket──▶ Daemon
                                                              │
                                                   Native Host (relay)
                                                              │
Extension Background ──chrome.tabs.sendMessage──▶ Content Script ──▶ Browser DOM
(Service Worker)       chrome.debugger (CDP)              │
                        chrome.scripting (MAIN world)      └── Element/patch registries
```

**Outbound:** Agent calls MCP tool → `BridgeClient` sends `{ type: 'agent.request', request }` as JSON-lines over TCP/socket → Daemon routes to extension socket → Native host relays to Chrome native messaging → Background service worker dispatches to content script or handles directly.

**Inbound:** Content script returns result → Background wraps into `createSuccess`/`createFailure` → Native host relays to daemon → Daemon matches pending request → `{ type: 'agent.response', response }` back to agent socket.

Two transport segments:
- **Agent ↔ Daemon**: TCP (`127.0.0.1:9223`) or Unix domain socket, newline-delimited JSON.
- **Extension ↔ Daemon**: Chrome Native Messaging (4-byte LE length-prefixed binary) over stdio, relayed by the native-host subprocess.

### Package Map

| Package | Entry | Responsibility |
|---|---|---|
| `packages/protocol/` | `src/index.js` | Shared types, error codes, method registry, defaults, budget presets. All other packages import from here. |
| `packages/native-host/` | `src/daemon.js` | `BridgeDaemon` — TCP/socket server, request routing, pending request tracking with timeouts. `src/native-host.js` relays between Chrome native messaging and daemon socket. |
| `packages/agent-client/` | `src/client.js` | `BridgeClient` — connects to daemon, sends requests, tracks responses. `src/cli.js` is the `bbx` CLI. |
| `packages/mcp-server/` | `src/server.js` | MCP stdio server (tool schemas). `src/handlers-*.js` map tool calls to bridge requests. |
| `packages/extension/` | `src/background.js` | MV3 service worker — native port, request dispatch, state management. `src/content-script.js` handles all DOM operations. |

### Where to Find Things

**Protocol concerns** (shared by all packages):
- Types & method shapes: `packages/protocol/src/types.js`
- Method registry: `packages/protocol/src/registry.js`
- Error codes & `BridgeError`: `packages/protocol/src/errors.js`
- Defaults & budget presets: `packages/protocol/src/defaults.js`
- Request/response factories: `packages/protocol/src/protocol.js`

**Daemon internals**:
- Core daemon class: `packages/native-host/src/daemon.js`
- Native messaging relay: `packages/native-host/src/native-host.js`
- Socket path config: `packages/native-host/src/config.js`
- Binary framing: `packages/native-host/src/framing.js`

**Extension internals**:
- Main service worker: `packages/extension/src/background.js`
- Bridge request validation: `packages/extension/src/background-bridge.js`
- Tab resolution & routing: `packages/extension/src/background-routing.js`
- Access/window management: `packages/extension/src/background-access.js`
- CDP coordinator: `packages/extension/src/debugger-coordinator.js`
- Content script (DOM ops): `packages/extension/src/content-script.js`
- Content script helpers: `packages/extension/src/content-script-helpers.js`

**Agent client**:
- Bridge client class: `packages/agent-client/src/client.js`
- CLI entry point: `packages/agent-client/src/cli.js`
- Command definitions: `packages/agent-client/src/command-registry.js`
- Skill install logic: `packages/agent-client/src/install.js`
- MCP config generation: `packages/agent-client/src/mcp-config.js`

**MCP server**:
- Tool registration & schemas: `packages/mcp-server/src/server.js`
- Handler dispatch: `packages/mcp-server/src/handlers.js`
- Domain handlers: `handlers-dom.js`, `handlers-page.js`, `handlers-navigation.js`, `handlers-capture.js`

### Method Dispatch (Extension Side)

The extension's `dispatchBridgeRequest()` handles methods by category:

- **System** (background handles directly): `health.ping`, `access.request`, `skill.get_runtime_context`
- **Tabs** (delegated to `background-tabs.js`): `tabs.list`, `tabs.create`, `tabs.close`
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
```

Also: `bbx-daemon` (start daemon), `bbx-install <ext-id>` (install manifest directly), `bbx-mcp` (start MCP server directly).

For agent debugging inside this repo, prefer `bbx -- ...` when a user asks to use the browser-bridge skill or `bbx` commands so the workspace CLI is exercised directly. Keep end-user documentation, the shipped skill, and consumer-facing guidance using `bbx`, `bbx-daemon`, and `bbx-install` as globally installed commands.

## Development Commands

```bash
npm install                    # install deps + postinstall
npm run lint                   # oxlint + oxfmt check
npm run format                 # oxfmt fix
npm run typecheck              # tsc --noEmit
npm test                       # run all tests with c8 coverage
npm run coverage:check         # verify 80% lines / 75% branches
npm run package:extension      # build extension ZIP for CWS
npm run release:check          # full pre-release validation

bbx -- status         # check bridge health from this repo checkout
npm run daemon                 # start daemon locally
```

## Skill Structure

- `skills/browser-bridge/SKILL.md` - core rules, quick reference, access flow (always loaded)
- `skills/browser-bridge/references/protocol.md` - full method table, error codes (load when exploring methods)
- `skills/browser-bridge/references/token-efficiency.md` - budget presets, anti-patterns (load when optimizing)
- `skills/browser-bridge/references/patch-workflow.md` - style/DOM patch loops (load when patching)
- `skills/browser-bridge/references/interaction.md` - input, navigation, form controls (load when interacting)

## Working Rules

- **ESM only** — `"type": "module"` in root package.json. All source uses `import`/`export`.
- **No build step** — runs directly from source. TypeScript is used only for type checking (`tsc --noEmit`).
- **Tests use Node built-in runner** — `node --test`, not Jest/Mocha. Test files in `packages/*/test/*.test.js`. Integration tests in `packages/integration-tests/`.
- **Linting** — `oxlint` (Rust-based), formatting with `oxfmt`. 2-space indent, single quotes, semicolons, trailing commas.
- **Node >= 18** — no Node 20+ only APIs.
- Preserve the generic protocol shape. Do not add task-specific bridge commands for one-off actions when an existing RPC method can express the action.
- Prefer improving the shared protocol, client ergonomics, or skill/docs over introducing special-case commands.
- Keep the bridge token-efficient. Favor structured DOM/style data over screenshots or raw HTML dumps.
- Treat extension content scripts as classic scripts. Do not add ESM `import` statements to manifest-declared content scripts.
- Keep native-host startup robust for GUI launch contexts. Do not assume shell-specific `PATH` resolution.
- Treat the top-level `README.md` as npm-facing documentation. When adding or editing links or image references there, prefer absolute GitHub URLs instead of relative paths so the npm package page renders them correctly.

## JavaScript Typing

- Raw `.js` source files must always include JSDoc typings.
- Start raw JS modules with `// @ts-check`.
- Add JSDoc typedefs and annotations for exported functions, key internal helpers, parameters, return values, and non-obvious structured data.
- Do not leave newly added raw JS logic untyped.
- Run `npm run typecheck` after changing JS sources.

## Validation

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run lint` to check code style and formatting.
- **After any AI edits**: Always run `npm run lint`, `npm run typecheck`, and `npm test` to ensure changes don't break existing functionality.
- When touching the extension/browser protocol path, verify at least one live CLI flow against Chrome if possible.

## Agent Support Maintenance

When adding or modifying agent/editor support (e.g., adding a new IDE or agent client):

1. **Alignment requirement**: Agent support must be kept consistent across:
   - Code base: `packages/agent-client/src/install.js` (supportedTargets, skill paths)
   - Code base: `packages/agent-client/src/mcp-config.js` (MCP_CLIENT_NAMES, config shapes, paths)
   - Documentation: `README.md` (text descriptions, example commands)
   - Documentation: `docs/quickstart.md` (supported clients list, example commands)
   - Extension UI: Side panel settings and host setup UI

2. **Order preservation**: Maintain the same agent order across all locations. Current order:
   - codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents

3. **README.md table restriction**: The "Supported Agents" table in `README.md` is **manually maintained** and should NOT be modified by AI agents. Only update text descriptions and example commands in README.md, not the visual table layout.

4. **When adding a new agent**:
   - Add to `supportedTargets` array in `install.js`
   - Add to `MCP_CLIENT_NAMES` in `mcp-config.js`
   - Add MCP config shape (key, includeType) to `MCP_CONFIG_SHAPES`
   - Add global and local config paths to `getMcpConfigPath`
   - Add global and local skill paths to `GLOBAL_SKILL_PATHS` and `LOCAL_SKILL_PATHS`
   - Update text descriptions in README.md and `docs/quickstart.md`
   - Update example commands in `docs/quickstart.md`
   - Do NOT modify the Supported Agents table in README.md

## CLI and Protocol Expectations

- `packages/agent-client/src/cli.js` is registered as `bbx` via the `bin` field in `package.json`.
- `package.json` uses the publish name `@browserbridge/bbx`.
- `npm link` from this repo exposes `bbx`, `bbx-mcp`, `bbx-daemon`, and `bbx-install` machine-wide for consumer repos.
- When working from this repository for debugging, treat `bbx -- ...` as the default agent invocation even if the user says `bbx` or asks to use the skill.
- Do not rewrite end-user docs or skill guidance to `npx`; published instructions should continue to assume the CLI is globally installed and invoked as `bbx`.
- Prefer the generic `call` path for arbitrary bridge methods.
- High-level helper commands are acceptable only when they map cleanly onto shared protocol methods and do not narrow the protocol surface.

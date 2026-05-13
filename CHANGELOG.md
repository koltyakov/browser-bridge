# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.5.0] - 2026-05-13

### Changed

- **MCP launch reliability:** Managed MCP configs now launch the bundled server
  with the current Node executable on every platform instead of relying on
  shell `bbx` resolution.
- **Browser install diagnostics:** `bbx doctor` now treats any installed browser
  native-host manifest as a valid setup and no longer reports partial manifest
  installs as issues.
- **Role search accessibility:** DOM role searches now resolve
  `aria-labelledby` references to label element text before falling back to
  `aria-label`, `title`, or visible text.

### Fixed

- **Access request scoping:** Access requests now reject attempts to enable a
  different browser window while Browser Bridge is already enabled elsewhere,
  returning structured details about the active and requested targets.
- **Debugger session recovery:** CDP operations now detect externally detached
  debugger sessions, clear stale coordinator state, and retry the operation
  after reattaching.
- **Protocol validation robustness:** Page evaluation now requires a non-empty
  expression, JSON-line socket writes reject oversized messages before sending,
  and numeric protocol values are normalized to bounded integers.
- **CLI error typing:** CLI daemon connection errors now extract error codes
  without untyped casts.

## [1.4.0] - 2026-05-12

### Added

- **TCP daemon authentication:** TCP daemon connections now use a local bridge
  auth token during agent and extension registration, rejecting unauthenticated
  sockets before they can send bridge messages.
- **MCP workflow guidance:** The MCP server now advertises Browser Bridge usage
  instructions and prompt templates for investigation, layout debugging, and
  flow verification so MCP clients can discover token-efficient workflows
  without shelling out to `bbx`.
- **Safer MCP retry handling:** MCP bridge calls now retry only methods that are
  safe to repeat, including read-only browser inspection calls and non-clearing
  console/network reads.

### Changed

- **Tool input validation:** MCP schemas and handlers now reject missing or
  invalid required fields earlier for DOM waits, text and role searches, hit
  tests, patch operations, captures, navigation, input, tab ids, limits, and
  timeouts.
- **Browser inspection reliability:** DOM queries now report truncation more
  accurately, text search uses a bounded scan path, wait observers debounce DOM
  mutation checks, and CDP cleanup for accessibility and performance reads is
  more robust.
- **Release automation:** CI and release workflows now watch the broader set of
  package, documentation, skill, and workflow files touched by Browser Bridge
  changes.

### Fixed

- **Large screenshot handling:** Screenshot capture now rejects oversized clips
  with structured `RESULT_TRUNCATED` details instead of attempting captures that
  can exceed browser limits.
- **Debugger burst reuse:** CDP debugger sessions now reuse pending burst-idle
  attachments more safely and avoid stale detach timers during repeated browser
  operations.
- **Daemon request robustness:** The daemon now returns structured failures for
  invalid requests, duplicate in-flight request ids, unauthenticated messages,
  and response-write failures without leaving pending request timers behind.

## [1.3.0] - 2026-05-11

### Added

- **Configurable daemon log tailing:** `log.tail` now accepts a bounded `limit`
  parameter so agents and diagnostics can request just the amount of recent
  bridge log history they need.
- **Class DOM patch operations:** Reversible DOM patching now supports explicit
  class add and remove operations, with rollback preserving the element's prior
  class state.
- **Chromium browser setup guidance:** Installation docs now call out supported
  Chromium-based browsers and show `bbx install --browser` examples for Edge,
  Brave, Chromium, and Arc.

### Changed

- **Regression coverage:** Expanded CLI, MCP handler, protocol, daemon,
  extension background, page evaluation, access request, and content-script test
  coverage around the bridge paths updated in this release.

## [1.2.0] - 2026-05-07

### Added

- **Daemon diagnostics and metrics:** Added structured daemon logging and the
  `daemon.metrics` bridge method so agents and local tooling can inspect daemon
  uptime, active connections, pending requests, failure counts, and average
  response time.
- **Protocol version negotiation:** Health checks now advertise supported
  protocol versions and include migration hints when the CLI/MCP client and
  daemon are out of sync. The agent client also detects those mismatches and
  can restart a stale daemon automatically after upgrades.

### Fixed

- **Screenshot tab targeting:** `bbx screenshot --tab <id> <ref|selector>
  [path]` now forwards the selected tab consistently when resolving the target
  element and capturing the screenshot, instead of misparsing `--tab` as a
  positional argument.

## [1.1.0] - 2026-05-02

### Added

- **Windows platform support:** Browser Bridge now supports Windows end to end,
  including registry-based native-host installation, Windows-safe MCP launch
  commands, and default TCP transport wiring across the CLI, daemon, and MCP
  server.
- **CDP send key support:** Added `cdp.dispatch_key_event`, the
  `browser_input` `cdp_press_key` action, and `bbx cdp-press-key` so agents can
  send targeted CDP key presses without focusing the tab first.
- **Daemon restart command:** Added `bbx restart` to restart or start the local
  bridge daemon after upgrades or when recovering from a stuck bridge process.

### Fixed

- **Windows IPC reliability:** The daemon now listens on a Named Pipe on
  Windows instead of a Unix-domain-socket file path. Recent Node + Windows 11
  combinations fail with `EACCES` when calling `server.listen()` on any file
  path, preventing the daemon from starting; Named Pipes are the historical
  Windows IPC mechanism and bind reliably. Daemon startup also skips the
  `mkdir` / `access` / `rm` filesystem prep when the socket path is a Named
  Pipe, since pipes are not filesystem entries.
- **Windows install and launch reliability:** Native-host install/uninstall now
  resolves `reg.exe` from `SystemRoot` on Windows, and managed MCP configs use
  the local Node executable directly instead of relying on shell resolution of
  `bbx`.
- **CDP key handling:** CDP key dispatch now validates and normalizes `key`,
  `code`, and `modifiers` input and consistently sends the expected key press
  pair through `Input.dispatchKeyEvent`.

## [1.0.0] - 2026-04-03

### Added

- **Core platform:** Browser Bridge as a local bridge between coding agents and
  a real Chrome tab, preserving the existing browser state instead of starting
  from a clean automation session. This includes the Chrome extension, native
  messaging host, long-lived daemon, shared protocol package, agent client, and
  MCP server.
- **Browser inspection:** Structured DOM inspection for subtree queries,
  element description, text, HTML, attributes, semantic search by text or ARIA
  role, wait conditions, and accessibility-tree reads.
- **Page and runtime reads:** Page state, storage, visible page text, console
  output, network activity, performance metrics, and targeted JavaScript
  evaluation when structured reads are insufficient.
- **Layout and styling reads:** Computed styles, matched CSS rules, box model
  data, hit testing, scrolling, and viewport resizing.
- **Browser control:** Clicking, typing, focusing, hovering, keyboard input,
  form controls, drag-and-drop, tab management, and page navigation.
- **Capture and DevTools fallback:** Partial screenshots, DOM snapshots, and
  CDP-backed geometry and style reads for cases where standard DOM inspection is
  not enough.
- **Live patching:** Reversible style and DOM patching, plus patch listing,
  rollback, and session-baseline commit support so fixes can be proven in the
  browser before being moved into source.
- **CLI integration:** The `bbx` CLI with raw RPC access, shortcut commands,
  batch execution, diagnostics, and runtime skill/context helpers.
- **MCP integration:** The `bbx-mcp` server so MCP-capable agents can use
  Browser Bridge through native tool calls.
- **Agent setup flows:** Managed MCP and skill installation for Codex, Claude
  Code, Cursor, GitHub Copilot, OpenCode, Antigravity, Windsurf, and generic
  `.agents` setups.
- **Documentation and skills:** Agent-facing skill packaging plus quick-start,
  API, publishing, capability-matrix, contributor, and workflow documentation.
- **Validation and release tooling:** Automated tests across the protocol,
  native host, agent client, MCP server, and extension, plus linting, coverage
  checks, extension packaging validation, and release verification steps.
- **Access model and routing:** Explicit per-window enablement with active-tab
  default routing instead of ambient browser-wide access.
- **Protocol and efficiency model:** Structured, token-efficient browser reads
  with shared protocol types, normalization, error codes, recovery hints, and
  budget presets.
- **Runtime hardening:** Setup readiness checks, health and diagnostic flows,
  socket and config permission hardening, protocol negotiation, reconnect
  behavior, and disconnected-client handling.
- **Typing expectations:** Strict JSDoc-backed typing across the JavaScript
  codebase with repository-wide `npm run typecheck` validation.

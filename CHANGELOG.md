# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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

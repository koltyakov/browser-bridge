# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.9.0] - 2026-07-23

### Added

- **Metadata-only HAR export:** Added `network.export_har`, the `browser_page`
  `har` action, and `bbx har` for bounded HAR 1.2 export from an explicitly
  armed CDP network capture. Export preserves sanitized URL structure and
  observed status, redirect, failure, cache, and service-worker metadata while
  excluding headers, cookies, bodies, authorization values, and unsupported
  size/timing detail.
- **Recovery telemetry:** Health, daemon metrics, and `bbx doctor` now expose
  fixed, content-free five-minute recovery summaries and identify three-failure
  loops within 60 seconds with bounded category-specific guidance.
- **Deliberate exact storage reads:** Added `sensitive.read` and the
  `browser_sensitive_read` MCP tool for one exact local/session storage key,
  with atomic size rejection, no batching/retry/budget truncation, and visible
  Sensitive access activity that never stores the key or value.
- **Shared incidental-data sanitization:** Persisted activity, default and CDP
  network URLs, console diagnostics, extension errors, and daemon logs now
  share bounded URL/path/credential redaction.
- **Protocol-compatible npm auto-update:** Added an opt-in local policy that
  aligns a global CLI/native host install with the highest stable npm release on
  a protocol line advertised by the connected extension, with fixed-package
  validation, no downgrades, global-install verification, and cross-process
  update locking.
- **Explicit semantic DOM diffs:** Added short-lived, memory-only DOM baselines
  with create, compare, describe, and release operations; exact bounded change
  counts and semantic evidence; deterministic quotas; destination routing; and
  typed navigation invalidation.

### Changed

- **HAR delivery and CLI handling:** HAR exports support inline, artifact, and
  size-aware auto delivery. Short-lived owner-scoped artifacts expose no browser
  host path; `bbx har` downloads with the same client, verifies length and
  SHA-256, deletes the artifact, validates the HAR, and atomically writes it on
  the CLI host.
- **Performance contract clarity:** Performance output remains a raw CDP
  `Performance.getMetrics` point sample with browser-defined names and units,
  not Web Vitals or a Browser Bridge page-load measurement.
- **Storage discovery is metadata-only:** `page.get_storage`, `browser_page`
  storage, and `bbx storage` now return bounded key/presence metadata. Use the
  deliberate sensitive-read path when an exact value is required.
- **Read-only batch parity:** CLI, client, and MCP batches now share a 20-call
  limit, five-call concurrency bound, ordered results, and mutation rejection.

### Security

- **Sanitized HAR evidence:** HAR URLs remove credentials and fragments and
  redact query values while retaining hosts, paths, and query names. Inline
  byte limits remove complete oldest entries instead of truncating fields, and
  artifact files use private daemon storage with a five-minute lifetime.

## [1.8.0] - 2026-07-22

### Added

- **Reliable input targeting and optional native execution:** Targeted input operations now
  rank bounded selector candidates by actionability, reject ambiguous or
  obscured targets with structured errors, report resolution/execution
  metadata, support explicit CDP execution for click, hover, drag, type, and
  fill, and offer strict opt-in same-document stale-reference recovery.
- **Dialogs and event-aware URL waits:** Added explicit inspect, accept, and
  dismiss operations for observable JavaScript dialogs, plus exact, contains,
  and restricted-regex URL waits that observe full navigation and SPA history
  changes without adding a manifest permission.
- **Compact accessibility and all-resource network inspection:** Accessibility
  reads can filter compact or semantically interactive nodes and can scope a
  partial AX tree to one uniquely selected region, while optional CDP network
  capture adds an explicit start/read/clear/stop lifecycle for bounded document,
  script, stylesheet, image, fetch/XHR, WebSocket, and WebTransport metadata.
- **Semantic page extraction:** Added bounded `page.extract_content` text and
  Markdown extraction with optional stable-snapshot settlement, selector
  scoping, metadata, Readability processing in the Node client, and coherent
  semantic-root/body fallbacks without returning source HTML to the agent.
- **Flexible, truthful screenshots:** Element, region, and full-page captures
  support PNG, JPEG, and WebP encoding with bounded lossy quality. Element
  captures use complete page-coordinate clips without scrolling the page,
  advertise MIME/completeness metadata, and fail coherently when complete
  capture cannot be guaranteed.
- **Consolidated local diagnostics:** `bbx doctor` now combines local transport,
  extension/profile, enabled-window routing, protocol compatibility, debugger,
  capture, daemon metrics, setup, recent redacted events, and configured-but-
  unverified remote destination state.
- **Responsible-use and security policies:** Added a Responsible Use Agreement
  and vulnerability-reporting policy, with links from npm-facing documentation
  and the extension UI.

### Changed

- **Protocol 1.8 and documentation alignment:** Additive interaction, dialog,
  navigation-wait, extraction, accessibility, screenshot, network, and
  diagnostic contracts now ship as protocol 1.8, with npm, lockfile, extension,
  MCP schema, skill, privacy, and reviewer documentation aligned to implemented
  behavior.
- **Context-rich access confirmation:** Access prompts and enable confirmations
  now identify the requesting CLI or MCP source and bounded operation intent,
  show sanitized target context, and state that access covers the selected
  Chrome window until disabled, with generic fallback copy for older clients.
- **Connection and action-log observability:** `BridgeClient` can optionally
  preflight protocol compatibility on connect, while extension health checks
  are summarized in the action log instead of appearing as unexplained generic
  operations.
- **Input safety and observability:** Input results identify how the target was
  selected, whether scrolling or stale recovery occurred, the hit-test outcome,
  and the actual DOM or debugger-backed dispatch path. Input dispatch remains a
  browser event result, not a guarantee of application state change.
- **Atomic selector shortcuts:** Selector-based CLI input shortcuts now pass the
  selector to the final operation instead of resolving it in a separate request.
  Automatic stale mutation replay was replaced by explicit, opt-in recovery.
- **MCP command discovery:** Removed MCP prompt templates so clients such as
  OpenCode no longer expose Browser Bridge workflow prompts as slash commands;
  MCP server instructions continue to provide agent guidance.
- **Windows/Linux daemon discovery parity:** `bbx stop`/`bbx restart` can now
  find the running daemon even when the pid file is stale or missing on every
  platform, not just macOS. On Windows the default TCP transport's listener is
  discovered through `Get-NetTCPConnection` and only signalled after its
  command line is verified to be the bridge daemon; on Linux, socket-owner
  lookup falls back to `ss` (iproute2) when `lsof` is not installed, and TCP
  proxy listeners are verified through `/proc/<pid>/cmdline`.

### Fixed

- **Target and mutation race handling:** Native text input revalidates focus and
  target identity before each mutation boundary, drag paths guarantee release
  cleanup, and stale or rerendered post-mutation targets are reported without
  silently replaying an input.
- **Bounded stale recovery:** Recovery now returns `ELEMENT_AMBIGUOUS` when its
  bounded candidate scan cannot prove uniqueness instead of accepting a
  potentially incorrect replacement.
- **Dialog, capture, and teardown races:** Dialog actions detect replacement
  around their non-atomic CDP command and can unblock a CDP operation waiting on
  the modal itself. Network capture serializes ownership and detach/stop
  transitions, while access disable, window switch, and tab movement prevent
  stale debugger work from crossing into a fresh session and attempt
  best-effort rollback of active patches while clearing capture state.

### Security

- **Hardened TCP and proxy authentication:** Authentication tokens now use
  hashed constant-time comparison. Invalid proxy `bindHost` values fail closed
  instead of widening to `0.0.0.0`, and malformed enabled proxy configurations
  produce explicit warnings.
- **Privacy-preserving CDP network capture:** Returned all-resource metadata
  strips URL credentials and fragments, redacts query values, summarizes
  `data:` and `blob:` URLs, and excludes bodies, cookies, authorization values,
  and complete headers.

## [1.7.6] - 2026-07-18

### Changed

- **Coordinated restart:** `bbx restart` now reloads the daemon and asks all
  running Browser Bridge MCP servers to exit cleanly so their owning agents can
  relaunch the current installed version.
- **Node.js 20 minimum:** The supported Node.js runtime is now 20 or newer
  (Node 18 reached end-of-life). CI tests Node 20, 22, and 24, plus macOS and
  Windows runtime legs so the Named Pipe transport tests execute on Windows.
- **CLI internals reorganized:** `bbx` command implementations moved from the
  single `cli.js` into focused modules (`cli-args`, `cli-batch`, `cli-output`,
  `cli-proxy-remote`, `cli-setup-commands`) with no behavior change.

## [1.7.0] - 2026-07-02

### Added

- **Remote browser destinations:** Added named remote destinations across the
  CLI and MCP tools, including `bbx remote add`, `list`, `test`, and `remove`,
  explicit `destinationId` routing, and separate local and remote readiness
  reporting.
- **Remote proxy mode:** Added `bbx proxy enable`, `disable`, and `status` for
  exposing the daemon to a tunneled development machine, with authentication
  token management, side-panel status, and a dedicated remote-proxy guide.

### Changed

- **MCP destination routing:** Read-only MCP operations can use configured
  remote destinations when the local bridge is unavailable, while mutating
  operations remain pinned to an explicitly selected destination.
- **Remote-aware diagnostics:** Health and status flows now distinguish daemon
  reachability, extension readiness, and destination-specific failures instead
  of treating every connection as local.

### Fixed

- **Native connection stability:** Extension native-port startup now tracks
  pending connections and waits for a stable connection before reporting the
  bridge as ready.
- **Runtime serialization:** Console argument capture now handles large and
  circular objects safely, and fetch interception avoids unnecessary request
  cloning while preserving request bodies.

## [1.6.0] - 2026-06-09

### Added

- **Network request interception:** Added CDP Fetch-backed
  `network.intercept.add`, `remove`, `list`, and `clear` methods plus `bbx
  intercept` commands for continuing, blocking, or fulfilling matching browser
  requests.
- **Framework-safe form filling:** Added `input.fill` and the `bbx fill`
  shortcut to update native controls while triggering the events expected by
  React, Vue, Angular, and standard DOM listeners.
- **Tab activation:** Added `tabs.activate` and `bbx tab-activate` to bring a
  selected tab to the foreground.

### Changed

- **CLI tab targeting:** Shortcut commands now honor `--tab`, evaluation
  supports `--tab` and `--await`, and selector-based shortcuts retry once after
  stale element references.
- **Setup guidance:** Expanded Chromium sandbox compatibility notes, agent
  permission examples, and side-panel setup visibility for incomplete native
  host installations.

### Fixed

- **Content script recovery:** Content-script injection failures now return
  clearer restricted-page and extension-reload guidance instead of collapsing
  into generic internal errors.
- **Input and interception validation:** Hardened `input.fill` and network
  interception parameter handling, cleanup, and protocol capability metadata.

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

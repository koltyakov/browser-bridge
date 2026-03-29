# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-07-13

### Added
- browser extension support for Chrome, Chromium, Edge, and Brave, with side panel and popup UI for per-window access control
- native host daemon via `bbx-daemon`, using a Unix socket bridge with newline-delimited JSON
- MCP server via `bbx-mcp`, exposing bridge methods as tools for Codex, Claude, Cursor, and compatible clients
- CLI support via `bbx`, including shortcuts, batch mode, and inline help
- shared protocol types, error codes, recovery hints, budget presets, and parameter normalization
- setup commands via `bbx install`, `bbx install-mcp`, and `bbx install-skill`
- DOM inspection methods: `dom.query`, `dom.describe`, `dom.get_text`, `dom.get_html`, `dom.get_attributes`, `dom.find_by_text`, `dom.find_by_role`, `dom.wait_for`, and `dom.get_accessibility_tree`
- page methods: `page.get_state`, `page.evaluate`, `page.get_console`, `page.wait_for_load_state`, `page.get_text`, `page.get_network`, and `page.get_storage`
- style and layout methods: `styles.get_computed`, `styles.get_matched_rules`, `layout.get_box_model`, and `layout.hit_test`
- input methods: `input.click`, `input.type`, `input.focus`, `input.hover`, `input.press_key`, `input.set_checked`, `input.select_option`, and `input.drag`
- navigation methods: `navigation.navigate`, `navigation.reload`, `navigation.go_back`, and `navigation.go_forward`
- viewport methods: `viewport.scroll` and `viewport.resize`
- screenshot methods: `screenshot.capture_element` and `screenshot.capture_region`
- patch methods: `patch.apply_styles`, `patch.apply_dom`, `patch.list`, `patch.rollback`, and `patch.commit_session_baseline`
- performance metrics via `performance.get_metrics`
- tab management via `tabs.list`, `tabs.create`, and `tabs.close`
- access control via per-window enablement and `access.request`
- health and diagnostics via `health.ping`, `log.tail`, and `bbx doctor`
- CDP passthrough methods: `cdp.get_document`, `cdp.get_dom_snapshot`, `cdp.get_box_model`, and `cdp.get_computed_styles_for_node`
- side panel window activity histogram
- quick, normal, and deep token budget presets
- socket and config-directory permission hardening, plus ANSI escape stripping in CLI output
- malformed message handling, fail-fast disconnected-client behavior, protocol version negotiation, auto-reconnect, MCP retry handling, and single-instance daemon startup detection
- concurrent request tests for multi-agent daemon routing
- shared named constants for protocol and native-host limits and defaults
- registry-driven CLI command descriptions and full direct-method alias coverage
- strict TypeScript checking across the JavaScript codebase
- extracted background routing/window-scope helpers with unit coverage for routing enforcement
- `BridgeClient.batch(...)` for parallel client-side request dispatch
- coverage reporting with `c8` and a CI coverage threshold check
- extension packaging validation in CI, including ZIP content checks and build artifact upload
- contributor documentation in `CONTRIBUTING.md` and SDK documentation in `docs/API.md`

[0.1.0]: https://github.com/browserbridge/bbx/releases/tag/v0.1.0

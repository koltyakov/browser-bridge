# Browser Bridge

<p align="center">
  <img src="./assets/logo.png" alt="expose logo" width="220" />
</p>

Browser Bridge is a dev-first interface between a local coding agent and a real Chrome tab. It gives the agent structured access to DOM, styles, layout, console state, interactions, and reversible patches through a local extension plus native host, instead of forcing the workflow through repeated screenshots, raw HTML dumps, or a full end-to-end automation stack.

The goal is simple: let any local AI coding agent inspect what the browser is doing, verify a change, try a patch, and carry the real fix back into source code with minimal token waste and tight scope control.

For end-user setup in other repos, see [QUICKSTART.md](QUICKSTART.md). For the category-level comparison and benchmark structure, see [docs/browser-automation-comparison.md](docs/browser-automation-comparison.md).

## What Browser Bridge Is For

Browser Bridge is useful when an agent needs to work against a live browser tab during development, especially when the browser is part of a build-test-verify loop rather than a standalone automation task.

Typical scenarios:

- Debugging a broken UI on `localhost` by reading DOM, computed styles, layout, console logs, and network state
- Verifying that a code change actually rendered the expected result in Chrome
- Comparing built UI against a design or screenshot, then patching the live page to prove the fix before editing source
- Running agent-guided browser checks from different local tools, not just one model vendor's app
- Keeping browser inspection scoped and token-efficient instead of shipping large screenshots or page dumps back to the model

## Why This Project Exists

There are already adjacent products in this space, but they optimize for different things.

[`Claude in Chrome`](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) positions itself as a browser extension that lets Claude "read, click, and navigate websites alongside you" from a side panel, with browser-use workflows, shortcuts, and scheduled tasks. MCP browser automation servers position themselves around generic browser control from AI apps. [`Playwright`](https://playwright.dev/) and similar browser automation tools position themselves around deterministic automation, end-to-end testing, reproducibility, and CI-friendly scripted control.

Browser Bridge is aiming at a narrower, more engineering-focused problem: give coding agents a precise, local, open-source browser bridge for inspection, debugging, and patch verification in the real browser state the user already has, not only in freshly automated contexts.

## Why Browser Bridge Can Be a Better Fit

Browser Bridge is not trying to be a general consumer browser assistant. It is trying to be a better browser tool for agentic software development.

- **Open-source and local-first**: the extension, native host, protocol, CLI, and skill live in this repo under MIT, with no vendor-specific hosted runtime in the loop.
- **Agent-agnostic**: the `bbx` CLI and shipped skill files are meant to work with local coding agents and IDE flows, not only a single AI product.
- **Token-efficient by design**: structured DOM, style, layout, console, and page-state reads are the default path; screenshots are escalation, not the primary transport.
- **Scoped access**: Browser Bridge uses explicit tab enablement plus tab-and-origin-scoped sessions instead of broad ambient browser control.
- **Real tab state first**: Browser Bridge starts from the actual Chrome tab the user already has open, with its current login state, storage, app state, and page history.
- **Patch-first developer workflow**: agents can test a CSS or DOM fix in the live page, inspect the result, then move the real fix into source and roll back the temporary patch.
- **Built for verification, not just automation**: the strongest use cases are debugging, design QA, regression checks, and "did the code change actually work?" loops.

That last point matters in practice. A lot of agentic troubleshooting is not about automating a clean room browser session. It is about understanding the messy, valuable state that already exists in a real tab: logged-in sessions, feature flags, seeded local storage, long-lived SPA state, extensions, unsaved form input, and whatever path the user actually took to get the bug.

Playwright, Puppeteer, and similar headless automation stacks are excellent for deterministic tests, scripted flows, crawling, and CI. But they often start from isolated or tool-managed browser contexts by design. That is a strength for reproducibility. It is also why reproducing the exact user/browser state can become part of the work.

Browser Bridge is optimized for the opposite starting point: inspect the browser state that already exists, use structured reads to understand it, test a patch in place, and then fix the source.

## Quick Comparison

| Product | How it positions itself | Best fit | Where Browser Bridge differs |
|------|---------|---------|---------|
| [Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) | Anthropic browser extension for Claude to read, click, navigate, and run browser workflows from a side panel | Integrated Claude experience and broader end-user browser tasks | Browser Bridge is model-agnostic, open-source, and centered on structured developer inspection and verification workflows |
| MCP browser automation servers | MCP server + browser extension flows for operating the browser from AI apps | General browser automation from MCP-capable tools | Browser Bridge is narrower on purpose: explicit scoped sessions, low-token structured reads, reversible patching, and a skill-oriented dev workflow |
| [Playwright](https://playwright.dev/) / Playwright MCP-style setups | Browser automation and testing with isolated browser contexts, reusable auth state, and scripted control | Deterministic end-to-end tests, CI, scripted reproduction, codegen, and automation | Browser Bridge starts from the user's existing Chrome tab and state by default, which is often the faster path for agentic debugging and verification |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) and other DevTools/headless tools | Coding-agent access to Chrome automation, debugging, and performance tooling | Deep debugging, traces, audits, and automation from MCP clients | Browser Bridge focuses more narrowly on scoped live-tab inspection, low-token DOM/style/layout reads, and reversible patch workflows in the user's active browser context |

If you want an AI to operate the browser as a general assistant, the other tools may be a closer match. If you want a browser companion for coding agents that is local, inspectable, scriptable, and optimized for debugging a real app, that is the lane Browser Bridge is trying to own.

For the comparison page, feature matrix, and benchmark scenario templates, see [docs/browser-automation-comparison.md](docs/browser-automation-comparison.md) and [benchmarks/browser-automation-comparison/README.md](benchmarks/browser-automation-comparison/README.md).

## What's in this repo

| Path | Purpose |
|------|---------|
| `manifest.json` | Unpacked Chrome extension manifest |
| `packages/extension` | Extension service worker, content script, popup, side panel, offscreen cropper |
| `packages/protocol` | Shared RPC schema, token-budget utilities |
| `packages/native-host` | Local bridge daemon, Chrome native host adapter, manifest installer |
| `packages/agent-client` | CLI (`bbx`) for agents and developers |
| `packages/mcp-server` | MCP compatibility layer on top of the shared bridge client |
| `skills/browser-bridge` | Agent skill with modular reference docs |

## Quick Start

```bash
npm install
npm run typecheck       # validate JSDoc types
npm test                # run protocol + daemon + client tests
npm link                # optional but recommended: expose bbx/bbx-daemon machine-wide
```

After `npm link`, the `bbx` CLI works from any repo, including non-Node repos.
After publish, the package entry point will be `npx @browserbridge/bbx ...`.

For consumer repo setup, install the native host with `bbx install`, use `bbx doctor` to verify readiness, connect MCP clients with `bbx mcp config <client>`, or install/update Browser Bridge skill files with `bbx install-skill`.

For maintainer release steps, see [PUBLISHING.md](PUBLISHING.md).

### Setup Native Messaging

```bash
# Install manifest using the official extension ID when configured
bbx install

# For unpacked dev builds or before the store ID is wired in:
bbx install <extension-id>
```

### Start the Daemon

```bash
bbx-daemon           # explicit start (native host also auto-bootstraps)
```

### Load Extension

1. Preferred user path: install the Browser Bridge extension from the Chrome Web Store when available.
2. Repo-development path: go to `chrome://extensions` → Load unpacked → select this repo root.
3. Open the popup or side panel → enable agent communication for the current tab.

### Use the CLI

```bash
bbx status                    # check bridge connection
bbx doctor                    # diagnose install/session readiness
bbx tabs                      # list available tabs
bbx request-access            # get session for active tab
bbx mcp config cursor         # print MCP config snippet
bbx call dom.query '{"selector":"main","maxNodes":8}'
bbx call patch.apply_styles '{"target":{"selector":"body"},"declarations":{"background":"teal"}}'
bbx batch '[{"method":"dom.query","params":{"selector":"h1"}},{"method":"page.get_state","params":{}}]'
bbx skill                     # runtime budget presets + method groups
```

## npm Scripts

| Script | Command |
|--------|---------|
| `npm test` | Run all tests |
| `npm run typecheck` | Validate JSDoc types |
| `npm run package:extension` | Build the Chrome Web Store ZIP in `dist/` |
| `npm run release:check` | Run validation, build the ZIP, and dry-run the npm package |
| `npm run status` | Quick bridge status check |
| `npm run daemon` | Start bridge daemon |
| `npm run install-manifest` | Install native messaging manifest |

## CLI Aliases (via `bbx`)

| Category | Commands |
|----------|----------|
| Setup | `install [ext-id]`, `status`, `doctor`, `logs`, `tabs`, `skill`, `mcp serve`, `mcp config <client>` |
| Session | `request-access [tabId] [origin]`, `session`, `revoke` |
| Generic RPC | `call <method> [json]`, `batch '[...]'` |
| Inspect | `dom-query [sel]`, `describe <ref>`, `text <ref>`, `styles <ref> [props]`, `box <ref>` |
| Interact | `click <ref>`, `focus <ref>`, `type <ref> <text>`, `press-key <key> [ref]` |
| Patch | `patch-style <ref> prop=val`, `patch-text <ref> <text>`, `patches`, `rollback <id>` |
| Capture | `screenshot <ref> [path]` |

## Supported Capabilities (55 RPC methods)

- **Session**: `tabs.list`, `session.request_access`, `session.get_status`, `session.revoke`
- **Page/Nav**: `page.get_state`, `navigation.navigate`, `navigation.reload`, `navigation.go_back`, `navigation.go_forward`
- **DOM**: `dom.query`, `dom.describe`, `dom.get_text`, `dom.get_attributes`
- **Styles/Layout**: `styles.get_computed`, `styles.get_matched_rules`, `layout.get_box_model`, `layout.hit_test`
- **Viewport**: `viewport.scroll`
- **Input**: `input.click`, `input.focus`, `input.type`, `input.press_key`, `input.set_checked`, `input.select_option`
- **Patch**: `patch.apply_styles`, `patch.apply_dom`, `patch.list`, `patch.rollback`, `patch.commit_session_baseline`
- **Capture**: `screenshot.capture_element`, `screenshot.capture_region`
- **CDP**: `cdp.get_document`, `cdp.get_dom_snapshot`, `cdp.get_box_model`, `cdp.get_computed_styles_for_node`
- **Utility**: `health.ping`, `log.tail`, `skill.get_runtime_context`

## Key Concepts

- Extension is scoped to explicitly enabled tabs only
- `request-access` requires the tab to be enabled in the extension UI first
- Sessions are tab + origin scoped, auto-refreshed when possible
- DOM/style/layout reads are the primary path; screenshots are escalation
- All patch operations are reversible and session-scoped
- Native host auto-bootstraps the daemon on demand

## Distribution

Browser Bridge currently ships as a Node/npm CLI stack:

- `bbx` for agent and developer commands
- `bbx-mcp` and `bbx mcp serve` for MCP clients
- `bbx-daemon` for the local bridge daemon
- `bbx-install` for native messaging manifest installation

The current path is to keep the native host and daemon on the existing Node-based install flow.

For publishing the extension and npm package together, see [PUBLISHING.md](PUBLISHING.md).

For setup troubleshooting, see [DEBUG.md](DEBUG.md).

## License

MIT License. See [LICENSE](LICENSE) for details.

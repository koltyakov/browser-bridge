# Browser Bridge

Chrome extension + local Native Messaging stack that lets AI agents inspect and patch an authenticated tab with tight scope and low token overhead.

## What's in this repo

| Path | Purpose |
|------|---------|
| `manifest.json` | Unpacked Chrome extension manifest |
| `packages/extension` | Extension service worker, content script, popup, side panel, offscreen cropper |
| `packages/protocol` | Shared RPC schema, token-budget utilities |
| `packages/native-host` | Local bridge daemon, Chrome native host adapter, manifest installer |
| `packages/agent-client` | CLI (`npx bb`) for agents and developers |
| `skills/browser-bridge` | Agent skill with modular reference docs |

## Quick Start

```bash
npm install
npm run typecheck       # validate JSDoc types
npm test                # run protocol + daemon + client tests
```

### Setup Native Messaging

```bash
# Install manifest with your extension ID (from chrome://extensions)
npx bb install <extension-id>

# Or without ID (you'll need to edit the manifest later)
npx bb install
```

### Start the Daemon

```bash
npx bb-daemon           # explicit start (native host also auto-bootstraps)
```

### Load Extension

1. Go to `chrome://extensions` → Load unpacked → select this repo root
2. Open the popup or side panel → enable agent communication for the current tab

### Use the CLI

```bash
npx bb status                    # check bridge connection
npx bb tabs                      # list available tabs
npx bb request-access            # get session for active tab
npx bb call dom.query '{"selector":"main","maxNodes":8}'
npx bb call patch.apply_styles '{"target":{"selector":"body"},"declarations":{"background":"teal"}}'
npx bb batch '[{"method":"dom.query","params":{"selector":"h1"}},{"method":"page.get_state","params":{}}]'
npx bb skill                     # runtime budget presets + method groups
```

## npm Scripts

| Script | Command |
|--------|---------|
| `npm test` | Run all tests |
| `npm run typecheck` | Validate JSDoc types |
| `npm run status` | Quick bridge status check |
| `npm run daemon` | Start bridge daemon |
| `npm run install-manifest` | Install native messaging manifest |

## CLI Aliases (via `npx bb`)

| Category | Commands |
|----------|----------|
| Setup | `install [ext-id]`, `status`, `logs`, `tabs`, `skill` |
| Session | `request-access [tabId] [origin]`, `session`, `revoke` |
| Generic RPC | `call <method> [json]`, `batch '[...]'` |
| Inspect | `dom-query [sel]`, `describe <ref>`, `text <ref>`, `styles <ref> [props]`, `box <ref>` |
| Interact | `click <ref>`, `focus <ref>`, `type <ref> <text>`, `press-key <key> [ref]` |
| Patch | `patch-style <ref> prop=val`, `patch-text <ref> <text>`, `patches`, `rollback <id>` |
| Capture | `screenshot <ref> [path]` |

## Supported Capabilities (36 RPC methods)

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

## Bundling

See [BUNDLING.md](BUNDLING.md) for the Zig daemon research and bundling strategy.

For setup troubleshooting, see [DEBUG.md](DEBUG.md).

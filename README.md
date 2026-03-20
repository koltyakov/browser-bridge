# Browser Bridge

Browser Bridge is a Chrome extension plus local Native Messaging stack that lets Codex inspect and patch an authenticated tab with tight scope and low token overhead.

## What is in this repo

- `manifest.json`: unpacked Chrome extension manifest
- `packages/extension`: extension service worker, content script, popup, side panel, and offscreen cropper
- `packages/protocol`: shared RPC schema helpers and token-budget utilities
- `packages/native-host`: local bridge daemon, Chrome native host adapter, and manifest installer
- `packages/agent-client`: CLI that a Codex subagent can use to talk to the bridge
- `skills/browser-bridge`: Codex skill for efficient use of the bridge

## Quick start

1. Run `npm install`.
2. Run `npm run typecheck` to validate the repo-wide JSDoc and shared bridge types.
3. Run `npm test` to validate the shared protocol and local bridge pieces.
4. Run `node packages/native-host/bin/bridge-daemon.js` to start the local daemon if you want it running explicitly. The native host can also bootstrap it on demand.
5. Run `node packages/native-host/bin/install-manifest.js` to install the Chrome Native Messaging manifest.
6. Load this repository root as an unpacked Chrome extension.
7. Open the extension popup or side panel and turn on agent communication for the current tab.
8. Use `node packages/agent-client/src/cli.js skill`, `status`, or `tabs` to inspect the running bridge.

For local setup and troubleshooting details, see `DEBUG.md`.

## Supported Capabilities

Browser Bridge currently supports:

- tab discovery and session lifecycle: `tabs.list`, `session.request_access`, `session.get_status`, `session.revoke`
- page state and navigation: `page.get_state`, `navigation.navigate`, `navigation.reload`, `navigation.go_back`, `navigation.go_forward`
- DOM inspection: `dom.query`, `dom.describe`, `dom.get_text`, `dom.get_attributes`
- style and layout reads: `styles.get_computed`, `styles.get_matched_rules`, `layout.get_box_model`, `layout.hit_test`
- viewport control: `viewport.scroll`
- scoped input automation on enabled tabs: `input.click`, `input.focus`, `input.type`, `input.press_key`, `input.set_checked`, `input.select_option`
- reversible patching: `patch.apply_styles`, `patch.apply_dom`, `patch.list`, `patch.rollback`, `patch.commit_session_baseline`
- targeted screenshots: `screenshot.capture_element`, `screenshot.capture_region`
- CDP-backed reads when content-script reads are insufficient: `cdp.get_document`, `cdp.get_dom_snapshot`, `cdp.get_box_model`, `cdp.get_computed_styles_for_node`
- health and diagnostics: `health.ping`, `log.tail`, `skill.get_runtime_context`

The agent client has convenience commands for the common path. Anything else should go through the generic `call` command.

## Agent Client Usage

The bridge is intended to be driven by an agent through `packages/agent-client/src/cli.js`.

List tabs:

```bash
node packages/agent-client/src/cli.js tabs
```

Enable the current tab in the extension UI, then request access for the current active tab:

```bash
node packages/agent-client/src/cli.js request-access
```

Request access to a specific tab and origin:

```bash
node packages/agent-client/src/cli.js request-access 123 https://example.com
```

Use the generic call surface for methods that do not have a dedicated CLI wrapper:

```bash
node packages/agent-client/src/cli.js call tabs.list
node packages/agent-client/src/cli.js call page.get_state
node packages/agent-client/src/cli.js call navigation.navigate '{"url":"https://example.com","waitForLoad":true}'
node packages/agent-client/src/cli.js call dom.query '{"selector":"body","maxNodes":8,"maxDepth":2}'
node packages/agent-client/src/cli.js call dom.get_attributes '{"elementRef":"el_123"}'
node packages/agent-client/src/cli.js call styles.get_matched_rules '{"elementRef":"el_123"}'
node packages/agent-client/src/cli.js call layout.hit_test '{"x":120,"y":340}'
node packages/agent-client/src/cli.js call viewport.scroll '{"top":640,"behavior":"smooth"}'
node packages/agent-client/src/cli.js call input.set_checked '{"target":{"elementRef":"el_123"},"checked":true}'
node packages/agent-client/src/cli.js call input.select_option '{"target":{"elementRef":"el_456"},"values":["us"]}'
node packages/agent-client/src/cli.js call patch.apply_styles '{"target":{"selector":"body"},"declarations":{"background":"teal","background-color":"teal"}}'
node packages/agent-client/src/cli.js call screenshot.capture_region '{"x":0,"y":0,"width":320,"height":180}'
node packages/agent-client/src/cli.js call cdp.get_dom_snapshot '{"selector":"body"}'
node packages/agent-client/src/cli.js call patch.rollback '{"patchId":"patch_123"}'
```

Example: make the current tab background teal using the generic RPC flow:

1. Turn on agent communication for the tab in the popup or side panel, then request access:

```bash
node packages/agent-client/src/cli.js request-access
```

2. Call the patch method. `call` will reuse the saved session automatically for tab-bound methods:

```bash
node packages/agent-client/src/cli.js call patch.apply_styles '{"target":{"selector":"body"},"declarations":{"background":"teal","background-color":"teal"}}'
```

## Practical Notes

- The extension is scoped to explicitly enabled tabs.
- `request-access` will only succeed after the operator enables the tab in the popup or side panel.
- Sessions are tab- and origin-scoped and are refreshed automatically when possible.
- Use `page.get_state` to confirm readiness, focus, and scroll context before input or patch actions.
- DOM, style, and layout reads are the default path; screenshots and CDP reads are escalation tools.
- Input, viewport, and navigation automation are supported, but only on explicitly enabled tabs with an active session.
- Patch operations are reversible and session-scoped.

## Notes

- Turning the toggle off revokes sessions for that tab immediately.
- The generic protocol surface is broader than the convenience CLI wrappers.
- The native host can bootstrap the daemon on demand, but running it explicitly is useful while debugging startup issues.

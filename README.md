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

## Codex usage

The bridge is intended to be driven by a Codex subagent through `packages/agent-client/src/cli.js`.

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

Call the bridge directly for advanced usage:

```bash
node packages/agent-client/src/cli.js call tabs.list
node packages/agent-client/src/cli.js call dom.query '{"selector":"body","maxNodes":8,"maxDepth":2}'
node packages/agent-client/src/cli.js call patch.apply_styles '{"target":{"selector":"body"},"declarations":{"background":"teal","background-color":"teal"}}'
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

## Notes

- The extension is scoped to explicitly enabled tabs.
- Turning the toggle off revokes sessions for that tab immediately.
- DOM and style extraction are the default path; screenshots are targeted and cropped.
- Patch operations are reversible and session-scoped.
- The current MVP leaves click/type automation disabled by default.

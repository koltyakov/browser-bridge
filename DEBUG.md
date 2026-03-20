# Debug Guide

This project has three moving pieces:

- the Browser Bridge Chrome extension
- the local Native Messaging host
- the local agent CLI

When local debugging breaks, it is usually one of these:

- the extension is not loaded or not reloaded
- the native host manifest is installed but not bound to the real extension id
- the daemon socket or saved session is stale
- the requested method is valid at the protocol level but you are using the wrong CLI entry point

## Local Paths

- Native host manifest: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.browser_bridge.json`
- Bridge working directory: `~/.codex/browser-bridge`
- Bridge socket: `~/.codex/browser-bridge/bridge.sock`
- Saved session: `~/.codex/browser-bridge/current-session.json`

## First-Time Local Setup

1. Install dependencies and validate the repo.

```bash
npm install
npm run typecheck
npm test
```

2. Install the Native Messaging manifest.

```bash
node packages/native-host/bin/install-manifest.js
```

This writes:

- the manifest JSON under Chrome's `NativeMessagingHosts` directory
- a launcher script under `~/.codex/browser-bridge/native-host-launcher.sh`

3. Load the extension as an unpacked extension.

- Open `chrome://extensions`
- Turn on Developer mode
- Click `Load unpacked`
- Select this repository root

4. Bind the native host manifest to the actual extension id.

- Copy the extension id shown in `chrome://extensions`
- Open `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.browser_bridge.json`
- Replace `chrome-extension://__REPLACE_WITH_EXTENSION_ID__/` with `chrome-extension://<your-extension-id>/`

Example:

```json
{
  "allowed_origins": [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
  ]
}
```

5. Reload the extension in `chrome://extensions`.

The installer preserves `allowed_origins` if the manifest already exists, so after the first bind you can usually rerun `node packages/native-host/bin/install-manifest.js` without editing the id again.

## Normal Local Debug Flow

1. Start the daemon explicitly in one terminal when debugging startup issues.

```bash
node packages/native-host/bin/bridge-daemon.js
```

2. In another terminal, check bridge health.

```bash
node packages/agent-client/src/cli.js status
node packages/agent-client/src/cli.js skill
```

Expected result:

- `daemon: "ok"`
- `socketPath` points at `~/.codex/browser-bridge/bridge.sock`
- `extensionConnected` becomes `true` after the extension service worker connects
- `skill` returns the runtime guidance and example flow from the shared protocol layer

3. Open any tab, then open the extension popup or side panel and enable agent communication for that tab.

4. Request a session.

```bash
node packages/agent-client/src/cli.js request-access
```

5. Verify the saved session and basic bridge calls.

```bash
node packages/agent-client/src/cli.js session
node packages/agent-client/src/cli.js tabs
node packages/agent-client/src/cli.js dom-query body
```

6. Use the generic `call` path for methods without dedicated CLI commands.

Examples:

```bash
node packages/agent-client/src/cli.js call dom.get_attributes '{"elementRef":"el_123"}'
node packages/agent-client/src/cli.js call styles.get_matched_rules '{"elementRef":"el_123"}'
node packages/agent-client/src/cli.js call screenshot.capture_region '{"x":0,"y":0,"width":320,"height":180}'
node packages/agent-client/src/cli.js call cdp.get_dom_snapshot '{"selector":"body"}'
```

## Smoke Test

Use this short end-to-end check after reloads or local changes:

```bash
node packages/agent-client/src/cli.js status
node packages/agent-client/src/cli.js request-access
node packages/agent-client/src/cli.js call dom.query '{"selector":"body","maxNodes":4,"maxDepth":2}'
node packages/agent-client/src/cli.js tabs
```

If that works, the extension, native host, session storage, and RPC path are all basically healthy.

## Common Failure Modes

### `extensionConnected: false`

The daemon is up, but Chrome has not connected the extension to the native host.

Check:

- the extension is loaded and reloaded after recent code changes
- the native host manifest exists at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.browser_bridge.json`
- `allowed_origins` contains the real unpacked extension id
- the extension service worker has no startup error

Useful command:

```bash
node packages/agent-client/src/cli.js status
```

### Native host placeholder id still present

If the manifest still contains `__REPLACE_WITH_EXTENSION_ID__`, Chrome will not authorize the extension to connect.

Fix:

- update `allowed_origins`
- reload the extension

### Bridge socket problems

If the CLI cannot connect, the daemon may not be running and the extension/native host bootstrap may be failing.

Check:

```bash
ls -l ~/.codex/browser-bridge
node packages/native-host/bin/bridge-daemon.js
```

If the daemon starts manually, retry:

```bash
node packages/agent-client/src/cli.js status
```

### Method works in protocol but not as a top-level CLI command

The agent client only wraps the most common flows. Many valid methods are available only through `call`.

Use:

```bash
node packages/agent-client/src/cli.js call <method> '<params-json>'
```

Common examples:

- `dom.get_attributes`
- `styles.get_matched_rules`
- `layout.hit_test`
- `screenshot.capture_region`
- `patch.commit_session_baseline`
- `cdp.get_document`
- `cdp.get_dom_snapshot`
- `cdp.get_box_model`
- `cdp.get_computed_styles_for_node`

### Stale saved session

If tab-scoped calls fail after reloads, the saved session may point at an old tab or expired scope.

Fix:

```bash
node packages/agent-client/src/cli.js revoke
rm -f ~/.codex/browser-bridge/current-session.json
node packages/agent-client/src/cli.js request-access
```

### Extension UI says native host is disconnected

Open the service worker inspector from `chrome://extensions` and look for Native Messaging errors. Typical causes:

- wrong extension id in `allowed_origins`
- stale manifest after renaming the native app id
- Node path changed and the launcher needs to be regenerated

If needed, reinstall the manifest:

```bash
node packages/native-host/bin/install-manifest.js
```

## Useful Commands

```bash
node packages/agent-client/src/cli.js status
node packages/agent-client/src/cli.js logs
node packages/agent-client/src/cli.js skill
node packages/agent-client/src/cli.js tabs
node packages/agent-client/src/cli.js request-access
node packages/agent-client/src/cli.js session
node packages/agent-client/src/cli.js dom-query body
node packages/agent-client/src/cli.js describe <elementRef>
node packages/agent-client/src/cli.js styles <elementRef> display,position
node packages/agent-client/src/cli.js box <elementRef>
node packages/agent-client/src/cli.js revoke
```

## Clean Reset

When local state is suspect, do a full reset:

1. Quit the explicit daemon process if you started one.
2. Remove bridge state.

```bash
rm -f ~/.codex/browser-bridge/bridge.sock
rm -f ~/.codex/browser-bridge/current-session.json
```

3. Reinstall the native host manifest.

```bash
node packages/native-host/bin/install-manifest.js
```

4. Confirm `allowed_origins` still contains the real extension id.
5. Reload the unpacked extension.
6. Run the smoke test again.

## Notes

- This setup path is currently macOS-specific because the manifest installer targets `~/Library/Application Support/Google/Chrome/NativeMessagingHosts`.
- The client talks directly to the local daemon socket. It does not launch Chrome for you.
- `request-access` depends on a tab being explicitly enabled in the extension UI.
- Input, patch, screenshot, and CDP methods all require an active session for the enabled tab.

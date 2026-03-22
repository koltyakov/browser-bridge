# Debug Guide

This project has three moving pieces:

- the Browser Bridge Chrome extension
- the local Native Messaging host
- the local agent CLI (`bbx`)

When local debugging breaks, it is usually one of these:

- the extension is not loaded or not reloaded
- the native host manifest is installed but not bound to the real extension id
- the daemon socket or saved session is stale
- the requested method is valid at the protocol level but you are using the wrong CLI entry point

## Local Paths

| Path | Purpose |
|------|---------|
| `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.browser_bridge.json` | Native host manifest (macOS) |
| `~/.config/google-chrome/NativeMessagingHosts/com.codex.browser_bridge.json` | Native host manifest (Linux) |
| `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\com.codex.browser_bridge.json` | Native host manifest (Windows) |
| `$CODEX_HOME/browser-bridge/` | Bridge working directory (`CODEX_HOME` defaults to `~/.codex`) |
| `$CODEX_HOME/browser-bridge/bridge.sock` | Daemon socket |
| `$CODEX_HOME/browser-bridge/current-session.json` | Saved session |
| `$CODEX_HOME/browser-bridge/native-host-launcher.sh` | Native host launcher script |

## First-Time Local Setup

1. Install dependencies and validate the repo.

```bash
npm install
npm run typecheck
npm test
npm link
```

`npm link` is recommended when you want `bbx` and `bbx-daemon` available outside this repo checkout.

2. Load the extension as an unpacked extension.

- Open `chrome://extensions`
- Turn on Developer mode
- Click `Load unpacked`
- Select this repository root
- **Copy the extension ID** shown on the card (32 lowercase letters)

3. Install the Native Messaging manifest with the extension ID.

```bash
bbx install <extension-id>
```

`bbx install` with no argument only works when `BROWSER_BRIDGE_EXTENSION_ID` is already set in the environment.

This writes:

- the manifest JSON under Chrome's `NativeMessagingHosts` directory (auto-detected per platform)
- a launcher script under `~/.codex/browser-bridge/native-host-launcher.sh`
- the correct `allowed_origins` entry for your extension

If you skip the extension ID, the manifest gets a placeholder that you must edit manually later.

4. Reload the extension in `chrome://extensions`.

The installer merges with existing `allowed_origins`, so rerunning `bbx install <id>` after code changes is safe.

## Normal Local Debug Flow

1. Start the daemon explicitly in one terminal when debugging startup issues.

```bash
bbx-daemon
```

2. In another terminal, check bridge health.

```bash
bbx status
bbx skill
```

Expected result:

- `daemon: "ok"`
- `socketPath` points at `$CODEX_HOME/browser-bridge/bridge.sock`
- `extensionConnected` becomes `true` after the extension service worker connects
- `skill` returns the runtime guidance and example flow from the shared protocol layer

3. Open any tab, then open the extension popup or side panel and enable agent communication for that tab.

4. Request a session.

```bash
bbx request-access
```

5. Verify the saved session and basic bridge calls.

```bash
bbx session
bbx tabs
bbx dom-query body
```

6. Use the generic `call` path for methods without dedicated CLI commands.

Examples:

```bash
bbx call dom.get_attributes '{"elementRef":"el_123"}'
bbx call styles.get_matched_rules '{"elementRef":"el_123"}'
bbx call screenshot.capture_region '{"x":0,"y":0,"width":320,"height":180}'
bbx call cdp.get_dom_snapshot '{"selector":"body"}'
```

## Smoke Test

Use this short end-to-end check after reloads or local changes:

```bash
bbx status
bbx request-access
bbx call dom.query '{"selector":"body","maxNodes":4,"maxDepth":2}'
bbx tabs
```

If that works, the extension, native host, session storage, and RPC path are all basically healthy.

## Common Failure Modes

### `extensionConnected: false`

The daemon is up, but Chrome has not connected the extension to the native host.

Check:

- the extension is loaded and reloaded after recent code changes
- the native host manifest exists at the correct platform path (see Local Paths above)
- `allowed_origins` contains the real unpacked extension id
- the extension service worker has no startup error

Useful command:

```bash
bbx status
```

### Native host placeholder id still present

If the manifest still contains `__REPLACE_WITH_EXTENSION_ID__`, Chrome will not authorize the extension to connect.

Fix:

```bash
bbx install <your-extension-id>
```

Then reload the extension.

### Bridge socket problems

If the CLI cannot connect, the daemon may not be running and the extension/native host bootstrap may be failing.

Check:

```bash
ls -l ~/.codex/browser-bridge
bbx-daemon
```

If the daemon starts manually, retry:

```bash
bbx status
```

### Method works in protocol but not as a top-level CLI command

The agent client only wraps the most common flows. Many valid methods are available only through `call`.

Use:

```bash
bbx call <method> '<params-json>'
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
bbx revoke
rm -f ~/.codex/browser-bridge/current-session.json
bbx request-access
```

### Extension UI says native host is disconnected

Open the service worker inspector from `chrome://extensions` and look for Native Messaging errors. Typical causes:

- wrong extension id in `allowed_origins`
- stale manifest after renaming the native app id
- Node path changed and the launcher needs to be regenerated

If needed, reinstall the manifest:

```bash
bbx install <extension-id>
```

## Useful Commands

```bash
bbx status
bbx doctor
bbx logs
bbx skill
bbx tabs
bbx request-access
bbx session
bbx dom-query body
bbx describe <elementRef>
bbx styles <elementRef> display,position
bbx box <elementRef>
bbx revoke
```

## Clean Reset

When local state is suspect, do a full reset:

1. Quit the explicit daemon process if you started one.
2. Remove bridge state.

```bash
rm -f "${CODEX_HOME:-$HOME/.codex}/browser-bridge/bridge.sock"
rm -f "${CODEX_HOME:-$HOME/.codex}/browser-bridge/current-session.json"
```

3. Reinstall the native host manifest.

```bash
bbx install <extension-id>
```

4. Reload the unpacked extension.
5. Run the smoke test again.

## Notes

- The manifest installer auto-detects the platform (macOS, Linux, Windows).
- The client talks directly to the local daemon socket. It does not launch Chrome for you.
- `request-access` depends on a tab being explicitly enabled in the extension UI.
- Input, patch, screenshot, and CDP methods all require an active session for the enabled tab.

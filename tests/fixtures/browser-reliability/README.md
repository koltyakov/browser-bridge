# Real-Browser Reliability Fixture

This local page gives maintainers one deterministic target for interaction, dialog, navigation,
accessibility, and network baselines. It is a manual real-Chrome fixture; `server.test.ts` verifies
its routes and required markers without launching Chrome.

## Launch

```bash
npm run fixture:browser
# http://127.0.0.1:4173/
```

Override the port with `BBX_FIXTURE_PORT=4317 npm run fixture:browser` or
`npm run fixture:browser -- --port 4317`. The server always binds `127.0.0.1`, never a LAN
interface. An invalid or occupied port exits with a clear error. Stop it with `Ctrl+C`.

The page makes requests only to its own origin. Dialogs and `beforeunload` are never armed
automatically. The slow route is capped at one second, WebSockets time out after two seconds, and
the visible log retains at most 80 entries. Reload for a clean browser/cache baseline; **Reset
observable state** resets page controls and logs but intentionally does not clear browser cache or
history.

## Manual Baseline Matrix

Enable Browser Bridge for the fixture window, keep the observable panel visible, and record the
Chrome version plus each call's result/error and returned resolution/execution metadata. A result
is only successful when the expected `fixture-state` key or log entry also appears.

| Surface | DOM baseline | CDP/debugger baseline | Expected observation |
| --- | --- | --- | --- |
| Target resolution | Run `input.click` with `executionMode: "dom"` against `.duplicate-action`, `#overlay-target`, `#offscreen-target`, disabled/inert, zero-size, and pointer-events targets | Repeat with `executionMode: "cdp"` | Visible duplicate is selected uniquely; offscreen use reports scrolling; blocked/unavailable targets fail without a state entry |
| Native interactions | Click custom widget; hover `#hover-trigger`; drag source to target; click canvas; fill all three replacement inputs; send primary+Shift+K | Repeat each supported call in CDP mode | State records custom click, CSS tooltip becomes visible, drop/canvas coordinates are recorded, replacement generations advance, shortcut is recorded |
| Dialogs | Trigger each button in Chrome or DOM mode, then inspect and explicitly accept/dismiss with `page.handle_dialog` | Dialog inspection/handling itself uses CDP | Alert, confirm, prompt text/result, consecutive IDs, and no-dialog errors are explicit; arm `beforeunload` only for its dedicated navigation check |
| URL waits | Wait on `/spa/push-`, `/spa/replace-`, `fixture-hash-`, and `/redirect`, then activate the matching control | Same event source; debugger is not expected | Result identifies pushState, replaceState, hashchange, popstate/back, or redirect/full navigation and reports the final URL |
| Accessibility | Read normal AX tree, then compact and interactive-only variants | `dom.get_accessibility_tree` is CDP-backed | Hidden/inert/disabled/custom/menu/tooltip semantics are bounded; filtering preserves useful descendants and reports truncation |
| Network lifecycle | Prime default capture with `page.get_network {"clear":true}`, click **Reproduce network set**, then read | Start CDP capture, reproduce or reload, read, then stop in `finally` | Default capture shows fetch/XHR; CDP shows document, stylesheet, script, image, fetch, XHR, WebSocket, cache, slow, 503, and aborted-request metadata |

Useful call shapes:

```bash
bbx call input.click '{"target":{"selector":".duplicate-action"},"executionMode":"dom"}'
bbx call input.click '{"target":{"selector":".duplicate-action"},"executionMode":"cdp"}'
bbx call page.handle_dialog '{"action":"inspect"}'
bbx call page.wait_for_load_state '{"url":"/spa/push-","urlMatch":"contains","waitForLoad":false,"timeoutMs":10000}'
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":6,"compact":true}'
bbx call page.get_network '{"source":"cdp","capture":"start"}'
bbx call page.get_network '{"source":"cdp","capture":"read","limit":50}'
bbx call page.get_network '{"source":"cdp","capture":"stop"}'
```

Run URL waits and dialog handling from a second terminal/agent call when the triggering input call
is blocked. Always stop CDP network capture, disarm `beforeunload`, and reload the fixture after a
manual run.

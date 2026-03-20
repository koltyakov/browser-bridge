# Protocol Reference

## Core commands

Use the agent client CLI for the common bridge entry points:

```bash
node packages/agent-client/src/cli.js status
node packages/agent-client/src/cli.js logs
node packages/agent-client/src/cli.js skill
node packages/agent-client/src/cli.js request-access
node packages/agent-client/src/cli.js call <method> '{"params":"go-here"}'
node packages/agent-client/src/cli.js call "<session-id>" <method> '{"params":"go-here"}'
```

The CLI should stay generic. For tab-bound methods, `call <method>` reuses the saved session automatically. For richer browser actions, the subagent should speak the shared RPC methods through `call` or by using the bridge client library directly.

## Request envelope

```json
{
  "id": "req_123",
  "session_id": "sess_abc",
  "method": "dom.query",
  "params": {},
  "meta": {
    "protocol_version": "1.0",
    "token_budget": 1200
  }
}
```

## High-value methods

- `session.request_access`: create or reuse a session for a tab that the operator already enabled in the extension UI
- `session.get_status`: confirm the session is still valid
- `dom.query`: query a DOM region with strict budgets
- `dom.describe`: inspect one known element
- `styles.get_computed`: fetch only requested computed properties
- `layout.get_box_model`: verify box changes after a patch
- `input.click`: trigger a scoped DOM-level click on a target element
- `input.type`: type text into an input, textarea, or contenteditable target
- `input.press_key`: send one keyboard action such as `Enter` or `Backspace`
- `patch.apply_styles`: try a CSS-only fix
- `patch.apply_dom`: try a small reversible DOM mutation
- `patch.rollback`: revert one patch
- `screenshot.capture_element`: capture a cropped image for one element
- `cdp.get_dom_snapshot`: use a narrower DevTools read when the content script is not enough

## Failure handling

Important error codes:

- `ACCESS_DENIED`
- `SESSION_EXPIRED`
- `ORIGIN_MISMATCH`
- `CAPABILITY_MISSING`
- `ELEMENT_STALE`
- `NATIVE_HOST_UNAVAILABLE`

Treat `ELEMENT_STALE` as a signal to reacquire a fresh `elementRef` with a new DOM query.

If a content-script-backed request times out, the bridge now returns a concrete timeout failure instead of hanging indefinitely. Use a narrower `dom.query`, a direct `dom.describe`, or a CDP-backed read next.

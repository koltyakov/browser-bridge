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

Convenience wrappers exist for:

- `status`, `logs`, `tabs`, `request-access`, `session`, `revoke`
- `dom-query`, `describe`, `text`, `styles`, `box`
- `click`, `focus`, `type`, `press-key`
- `patch-style`, `patch-text`, `patches`, `rollback`
- `screenshot`

Use `call` for valid methods that do not have a wrapper.

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
- `page.get_state`: confirm URL, readiness, focus, viewport, scroll position, and active element context
- `navigation.navigate`: move the scoped tab to a new URL and optionally wait for load completion
- `navigation.reload`: reload the scoped tab and optionally wait for load completion
- `navigation.go_back`: move back in scoped tab history
- `navigation.go_forward`: move forward in scoped tab history
- `dom.query`: query a DOM region with strict budgets
- `dom.describe`: inspect one known element
- `dom.get_attributes`: read a targeted attribute set for one element
- `styles.get_computed`: fetch only requested computed properties
- `styles.get_matched_rules`: inspect matching CSS rules for a target element
- `layout.get_box_model`: verify box changes after a patch
- `layout.hit_test`: resolve which element owns a viewport point
- `viewport.scroll`: reposition the window or a specific scrollable element
- `input.click`: trigger a scoped DOM-level click on a target element
- `input.type`: type text into an input, textarea, or contenteditable target
- `input.press_key`: send one keyboard action such as `Enter` or `Backspace`
- `input.set_checked`: toggle a checkbox or radio target to the desired checked state
- `input.select_option`: select native `<select>` options by value, label, or index
- `patch.apply_styles`: try a CSS-only fix
- `patch.apply_dom`: try a small reversible DOM mutation
- `patch.commit_session_baseline`: move the current page state forward as the patch baseline
- `patch.rollback`: revert one patch
- `screenshot.capture_element`: capture a cropped image for one element
- `screenshot.capture_region`: capture a cropped image for an explicit viewport region
- `cdp.get_document`: request a DevTools-backed document tree
- `cdp.get_dom_snapshot`: use a narrower DevTools read when the content script is not enough
- `cdp.get_box_model`: inspect a node box model through DevTools
- `cdp.get_computed_styles_for_node`: inspect computed styles through DevTools

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

If a navigation action times out, retry with a larger `timeoutMs`, disable `waitForLoad` for intentionally long-lived pages, or inspect the tab with `page.get_state` after the move.

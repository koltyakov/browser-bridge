# Protocol Reference

Prefer non-debugger methods first. `chrome.debugger`-backed methods can cause Chrome to show its native "started debugging this browser" banner across the running browser instance, so use them only when DOM/content-script/native-script methods cannot answer the question.

## All Methods (53)

| # | Method | Needs Routed Tab? | Notes |
|---|--------|-------------------|-------|
| 1 | `tabs.list` | No | Discover available tabs |
| 2 | `tabs.create` | No | Open a new tab; optional `url` and `active` |
| 3 | `tabs.close` | No | Close a tab by `tabId` |
| 4 | `skill.get_runtime_context` | No | Live budget presets + method groups |
| 5 | `setup.get_status` | No | Global MCP config + CLI skill install status from the host |
| 6 | `health.ping` | No | Bridge connectivity check + access routing state |
| 7 | `log.tail` | No | Recent bridge logs |
| 8 | `page.get_state` | Yes | URL, readiness, focus, scroll, viewport |
| 9 | `page.evaluate` | Yes | Run JS expression in page context (CDP); debugger-backed, last resort for app state reads |
| 10 | `page.get_console` | Yes | Buffered console messages; filter by `level`, `limit` entries |
| 11 | `page.wait_for_load_state` | Yes | Block until tab status is 'complete'; `timeoutMs` capped at 30 s |
| 12 | `page.get_storage` | Yes | Read `localStorage` or `sessionStorage`; optional `keys` filter |
| 13 | `page.get_text` | Yes | Full page text extraction; `textBudget` limits size |
| 14 | `page.get_network` | Yes | Intercepted fetch/XHR requests; `limit` entries |
| 15 | `navigation.navigate` | Yes | Go to URL; `waitForLoad` default true |
| 16 | `navigation.reload` | Yes | Reload; `waitForLoad` default true |
| 17 | `navigation.go_back` | Yes | History back |
| 18 | `navigation.go_forward` | Yes | History forward |
| 19 | `dom.query` | Yes | Query subtree with budget constraints |
| 20 | `dom.describe` | Yes | Single element details via `elementRef` |
| 21 | `dom.get_text` | Yes | Text content with `textBudget` |
| 22 | `dom.get_attributes` | Yes | Targeted attribute read |
| 23 | `dom.wait_for` | Yes | Wait for DOM condition (selector + optional text, state: attached/detached/visible/hidden); async with MutationObserver + polling |
| 24 | `dom.find_by_text` | Yes | Find elements by visible text content; returns `{nodes, count}` |
| 25 | `dom.find_by_role` | Yes | Find elements by ARIA role (explicit or implicit); optional `name` filter |
| 26 | `dom.get_html` | Yes | Get `innerHTML`/`outerHTML` of element; `maxLength` truncation |
| 27 | `dom.get_accessibility_tree` | Yes | Full accessibility tree via CDP; debugger-backed; `maxNodes` and `maxDepth` limits |
| 28 | `layout.get_box_model` | Yes | Element geometry (no budget needed) |
| 29 | `layout.hit_test` | Yes | Element at viewport point |
| 30 | `styles.get_computed` | Yes | Computed CSS; always set `properties` |
| 31 | `styles.get_matched_rules` | Yes | Matching CSS rules |
| 32 | `viewport.scroll` | Yes | Window or element scroll |
| 33 | `viewport.resize` | Yes | Set viewport dimensions via CDP device emulation; debugger-backed; reset with `reset: true` |
| 34 | `input.click` | Yes | DOM-level click |
| 35 | `input.focus` | Yes | Focus element |
| 36 | `input.type` | Yes | Type text into input/textarea/contenteditable |
| 37 | `input.press_key` | Yes | Single key event |
| 38 | `input.set_checked` | Yes | Checkbox/radio toggle |
| 39 | `input.select_option` | Yes | Native select by value/label/index |
| 40 | `input.hover` | Yes | Dispatch mouseenter/mouseover/mousemove; optional `duration` ms to hold |
| 41 | `input.drag` | Yes | Full drag-and-drop event sequence (mousedown→dragstart→drag→drop→dragend) |
| 42 | `screenshot.capture_element` | Yes | Cropped element screenshot; debugger-backed |
| 43 | `screenshot.capture_region` | Yes | Cropped viewport region; debugger-backed |
| 44 | `patch.apply_styles` | Yes | Reversible CSS patch |
| 45 | `patch.apply_dom` | Yes | Reversible DOM mutation |
| 46 | `patch.list` | Yes | Active patches |
| 47 | `patch.rollback` | Yes | Revert one patch |
| 48 | `patch.commit_session_baseline` | Yes | Accept current state as baseline |
| 49 | `performance.get_metrics` | Yes | Chrome performance metrics via CDP; debugger-backed |
| 50 | `cdp.get_document` | Yes | DevTools document tree; debugger-backed |
| 51 | `cdp.get_dom_snapshot` | Yes | DevTools DOM snapshot; debugger-backed |
| 52 | `cdp.get_box_model` | Yes | DevTools-backed element geometry; debugger-backed |
| 53 | `cdp.get_computed_styles_for_node` | Yes | DevTools-backed computed styles; debugger-backed |

## CLI

```bash
bbx status | logs | tabs | skill            # no routed tab needed
bbx call <method> '{"key":"val"}'           # generic RPC (routes to active tab in enabled window)
bbx call --tab 123 <method> '{...}'         # explicit tab target inside enabled window
bbx batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `eval`, `console`, `wait`, `find`, `find-role`, `html`, `hover`, `navigate`, `storage`, `tab-create`, `tab-close`, `page-text`, `network`, `a11y-tree`, `perf`, `resize`

## New Method Details

### page.evaluate
Run a JS expression in the page context via CDP `Runtime.evaluate`. Expression is evaluated as a statement and the return value is serialized. Supports `awaitPromise` for async expressions.

Use only when non-debugger reads are insufficient. Prefer `page.get_storage`, `page.get_text`, `page.get_console`, `page.get_network`, or DOM methods first.
```bash
bbx eval 'document.title'
bbx eval 'window.__NEXT_DATA__.props'
bbx call page.evaluate '{"expression":"await fetch(\"/api/health\").then(r=>r.json())","awaitPromise":true}'
```

### page.get_console
Read buffered console output. The console interceptor is auto-installed on first call. Captures `log`, `warn`, `error`, `info`, `debug` plus uncaught exceptions and unhandled rejections.
```bash
bbx console                    # all levels
bbx console error              # errors only
bbx call page.get_console '{"level":"error","limit":20,"clear":true}'
```

### page.wait_for_load_state
Block until the tab reaches `complete` status. Useful after `input.click` on a navigation link.
```bash
bbx call page.wait_for_load_state '{"timeoutMs":10000}'
```

### page.get_storage
Read `localStorage` or `sessionStorage` entries. Values truncated at 500 chars each.
```bash
bbx storage                        # all localStorage
bbx storage session token,user     # specific sessionStorage keys
bbx call page.get_storage '{"type":"session","keys":["token"]}'
```

### dom.wait_for
Wait for a DOM condition using MutationObserver + 250 ms polling fallback. Returns `{found, elementRef, duration}`.
- `state`: `attached` (default), `detached`, `visible`, `hidden`
- `text`: optional text content filter
- `timeoutMs`: 100–30000 (default 5000)
```bash
bbx wait '.toast-success' 5000
bbx call dom.wait_for '{"selector":".modal","state":"visible","timeoutMs":10000}'
```

### dom.find_by_text
Find elements matching visible text content. Like Playwright's `getByText`.
```bash
bbx find 'Submit Order'
bbx call dom.find_by_text '{"text":"Submit","scope":"button","exact":false}'
```

### dom.find_by_role
Find elements by ARIA role (explicit `role` attribute or implicit from HTML tag). Covers 25+ implicit role mappings.
```bash
bbx find-role button 'Save'
bbx call dom.find_by_role '{"role":"navigation"}'
```

### dom.get_html
Get raw HTML of an element. Defaults to `innerHTML`; set `outer: true` for `outerHTML`.
```bash
bbx html el_abc123
bbx call dom.get_html '{"elementRef":"el_abc123","outer":true,"maxLength":2000}'
```

### input.hover
Trigger CSS `:hover` state by dispatching `mouseenter`, `mouseover`, `mousemove`. Optional `duration` to hold hover before auto-releasing.
```bash
bbx hover el_abc123
bbx call input.hover '{"target":{"elementRef":"el_abc123"},"duration":1000}'
```

### input.drag
Full drag-and-drop sequence: `mousedown → dragstart → drag → dragenter → dragover → drop → dragend → mouseup`. Accepts source target, destination target, and optional pixel offsets.
```bash
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"}}'
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"sourceOffset":{"x":10,"y":10}}'
```

### tabs.create
Open a new browser tab. Optional `url` (defaults to `about:blank`) and `active` flag (defaults to `true`). Does not require a session.
```bash
bbx tab-create https://example.com
bbx call tabs.create '{"url":"https://example.com","active":false}'
```

The `bbx tab-create` shortcut intentionally covers the common case. Use `bbx call tabs.create ...` when you need advanced fields such as `active:false`.

### setup.get_status
Inspect the host-side Browser Bridge setup. Returns global MCP config status for supported clients and global CLI skill install status for supported targets.
```bash
bbx call setup.get_status
```

### tabs.close
Close a tab by its `tabId`. Does not require a session.
```bash
bbx tab-close 12345
bbx call tabs.close '{"tabId":12345}'
```

### page.get_text
Extract the full visible text content of the page (`document.body.innerText`). Truncated to `textBudget` (default 8000 chars). Lighter than `dom.query` on `body` when you only need text.
```bash
bbx page-text
bbx page-text 8000
bbx call page.get_text '{"textBudget":2000}'
```

### page.get_network
Read intercepted fetch/XHR requests. The interceptor is auto-installed on first call (via MAIN world script). Returns `{entries, count}` sorted newest-first.
```bash
bbx network
bbx network 50
bbx call page.get_network '{"limit":20,"clear":true}'
```
Each entry: `{method, url, status, duration, initiator}`.

### dom.get_accessibility_tree
Retrieve the page's accessibility tree via CDP `Accessibility.getFullAXTree`. Each node is simplified to: `role`, `name`, `description`, `value`, `focused`, `required`, `checked`, `disabled`, `interactive`, `childIds`. Use `maxNodes` and `maxDepth` to control size.

This is debugger-backed. Prefer `dom.find_by_role`, `dom.find_by_text`, and targeted `dom.query`/`dom.describe` first.
```bash
bbx a11y-tree
bbx a11y-tree 50 3
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5}'
```

### viewport.resize
Set the browser viewport to specific dimensions using CDP device emulation. Pass `reset: true` to clear the override.

Debugger-backed. Use only when an exact viewport override is required for responsive verification.
```bash
bbx resize 375 812
bbx call viewport.resize '{"width":1024,"height":768}'
bbx call viewport.resize '{"reset":true}'
```

### performance.get_metrics
Read Chrome performance counters via CDP `Performance.getMetrics`. Returns a flat `{metrics}` object with keys like `JSHeapUsedSize`, `LayoutCount`, `TaskDuration`, etc.

Debugger-backed. Use after lighter reads fail to explain a performance symptom.
```bash
bbx perf
bbx call performance.get_metrics
```
## Request Envelope

```json
{"id":"req_1","tab_id":123,"method":"dom.query","params":{},"meta":{"protocol_version":"1.0","token_budget":1200}}
```

## Error Codes

| Code | Action |
|------|--------|
| `ACCESS_DENIED` | Turn on Browser Bridge for the target browser window, or switch to a supported page |
| `TAB_MISMATCH` | Explicit `tabId` is missing, closed, or outside the enabled window |
| `ELEMENT_STALE` | Re-query DOM for fresh `elementRef` |
| `NATIVE_HOST_UNAVAILABLE` | Check daemon: `bbx status` |
| `EXTENSION_DISCONNECTED` | Extension not connected to daemon - check Chrome |
| `TIMEOUT` | Wait/evaluate exceeded `timeoutMs`; increase timeout or check condition |

Timeout on content-script request → use narrower `dom.query` or CDP fallback.
Timeout on navigation → increase `timeoutMs`, set `waitForLoad:false`, or check `page.get_state`.
Timeout on `dom.wait_for` → returns `{found: false}` (not an error); check selector/state logic.

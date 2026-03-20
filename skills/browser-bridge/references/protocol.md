# Protocol Reference

## All Methods (55)

| # | Method | Session? | Notes |
|---|--------|----------|-------|
| 1 | `tabs.list` | No | Discover available tabs |
| 2 | `tabs.create` | No | Open a new tab; optional `url` and `active` |
| 3 | `tabs.close` | No | Close a tab by `tabId` |
| 4 | `session.request_access` | No | Create/reuse session (tab must be UI-enabled) |
| 5 | `session.get_status` | Yes | Confirm session validity |
| 6 | `session.revoke` | Yes | End session |
| 7 | `skill.get_runtime_context` | No | Live budget presets + method groups |
| 8 | `health.ping` | No | Bridge connectivity check |
| 9 | `log.tail` | No | Recent bridge logs |
| 10 | `page.get_state` | Yes | URL, readiness, focus, scroll, viewport |
| 11 | `page.evaluate` | Yes | Run JS expression in page context (CDP); requires `page.evaluate` capability |
| 12 | `page.get_console` | Yes | Buffered console messages; filter by `level`, `limit` entries |
| 13 | `page.wait_for_load_state` | Yes | Block until tab status is 'complete'; `timeoutMs` capped at 30 s |
| 14 | `page.get_storage` | Yes | Read `localStorage` or `sessionStorage`; optional `keys` filter |
| 15 | `page.get_text` | Yes | Full page text extraction; `textBudget` limits size |
| 16 | `page.get_network` | Yes | Intercepted fetch/XHR requests; `limit` entries; requires `network.read` capability |
| 17 | `navigation.navigate` | Yes | Go to URL; `waitForLoad` default true |
| 18 | `navigation.reload` | Yes | Reload; `waitForLoad` default true |
| 19 | `navigation.go_back` | Yes | History back |
| 20 | `navigation.go_forward` | Yes | History forward |
| 21 | `dom.query` | Yes | Query subtree with budget constraints |
| 22 | `dom.describe` | Yes | Single element details via `elementRef` |
| 23 | `dom.get_text` | Yes | Text content with `textBudget` |
| 24 | `dom.get_attributes` | Yes | Targeted attribute read |
| 25 | `dom.wait_for` | Yes | Wait for DOM condition (selector + optional text, state: attached/detached/visible/hidden); async with MutationObserver + polling |
| 26 | `dom.find_by_text` | Yes | Find elements by visible text content; returns `{nodes, count}` |
| 27 | `dom.find_by_role` | Yes | Find elements by ARIA role (explicit or implicit); optional `name` filter |
| 28 | `dom.get_html` | Yes | Get `innerHTML`/`outerHTML` of element; `maxLength` truncation |
| 29 | `dom.get_accessibility_tree` | Yes | Full accessibility tree via CDP; `maxNodes` and `maxDepth` limits |
| 30 | `layout.get_box_model` | Yes | Element geometry (no budget needed) |
| 31 | `layout.hit_test` | Yes | Element at viewport point |
| 32 | `styles.get_computed` | Yes | Computed CSS; always set `properties` |
| 33 | `styles.get_matched_rules` | Yes | Matching CSS rules |
| 34 | `viewport.scroll` | Yes | Window or element scroll |
| 35 | `viewport.resize` | Yes | Set viewport dimensions via CDP device emulation; reset with `reset: true` |
| 36 | `input.click` | Yes | DOM-level click |
| 37 | `input.focus` | Yes | Focus element |
| 38 | `input.type` | Yes | Type text into input/textarea/contenteditable |
| 39 | `input.press_key` | Yes | Single key event |
| 40 | `input.set_checked` | Yes | Checkbox/radio toggle |
| 41 | `input.select_option` | Yes | Native select by value/label/index |
| 42 | `input.hover` | Yes | Dispatch mouseenter/mouseover/mousemove; optional `duration` ms to hold |
| 43 | `input.drag` | Yes | Full drag-and-drop event sequence (mousedown→dragstart→drag→drop→dragend) |
| 44 | `screenshot.capture_element` | Yes | Cropped element screenshot |
| 45 | `screenshot.capture_region` | Yes | Cropped viewport region |
| 46 | `patch.apply_styles` | Yes | Reversible CSS patch |
| 47 | `patch.apply_dom` | Yes | Reversible DOM mutation |
| 48 | `patch.list` | Yes | Active patches |
| 49 | `patch.rollback` | Yes | Revert one patch |
| 50 | `patch.commit_session_baseline` | Yes | Accept current state as baseline |
| 51 | `performance.get_metrics` | Yes | Chrome performance metrics via CDP; requires `performance.read` capability |
| 52 | `cdp.get_document` | Yes | DevTools document tree |
| 53 | `cdp.get_dom_snapshot` | Yes | DevTools DOM snapshot |
| 54 | `cdp.get_box_model` | Yes | DevTools-backed element geometry |
| 55 | `cdp.get_computed_styles_for_node` | Yes | DevTools-backed computed styles |

## CLI

```bash
npx bb status | logs | tabs | skill         # no session needed
npx bb request-access [tabId] [origin]       # create session
npx bb call <method> '{"key":"val"}'         # generic RPC (auto-session)
npx bb call <sessionId> <method> '{...}'     # explicit session
npx bb batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `session`, `revoke`, `eval`, `console`, `wait`, `find`, `find-role`, `html`, `hover`, `navigate`, `storage`, `tab-create`, `tab-close`, `page-text`, `network`, `a11y-tree`, `perf`, `resize`

## New Method Details

### page.evaluate
Run a JS expression in the page context via CDP `Runtime.evaluate`. Expression is evaluated as a statement and the return value is serialized. Supports `awaitPromise` for async expressions. Requires the `page.evaluate` capability.
```bash
npx bb eval 'document.title'
npx bb eval 'window.__NEXT_DATA__.props'
npx bb call page.evaluate '{"expression":"await fetch(\"/api/health\").then(r=>r.json())","awaitPromise":true}'
```

### page.get_console
Read buffered console output. The console interceptor is auto-installed on first call. Captures `log`, `warn`, `error`, `info`, `debug` plus uncaught exceptions and unhandled rejections.
```bash
npx bb console                    # all levels
npx bb console error              # errors only
npx bb call page.get_console '{"level":"error","limit":20,"clear":true}'
```

### page.wait_for_load_state
Block until the tab reaches `complete` status. Useful after `input.click` on a navigation link.
```bash
npx bb wait-load 10000
npx bb call page.wait_for_load_state '{"timeoutMs":10000}'
```

### page.get_storage
Read `localStorage` or `sessionStorage` entries. Values truncated at 500 chars each.
```bash
npx bb storage                        # all localStorage
npx bb storage session token,user     # specific sessionStorage keys
npx bb call page.get_storage '{"type":"session","keys":["token"]}'
```

### dom.wait_for
Wait for a DOM condition using MutationObserver + 250 ms polling fallback. Returns `{found, elementRef, duration}`.
- `state`: `attached` (default), `detached`, `visible`, `hidden`
- `text`: optional text content filter
- `timeoutMs`: 100–30000 (default 5000)
```bash
npx bb wait '.toast-success' 5000
npx bb call dom.wait_for '{"selector":".modal","state":"visible","timeoutMs":10000}'
```

### dom.find_by_text
Find elements matching visible text content. Like Playwright's `getByText`.
```bash
npx bb find 'Submit Order'
npx bb call dom.find_by_text '{"text":"Submit","scope":"button","exact":false}'
```

### dom.find_by_role
Find elements by ARIA role (explicit `role` attribute or implicit from HTML tag). Covers 25+ implicit role mappings.
```bash
npx bb find-role button 'Save'
npx bb call dom.find_by_role '{"role":"navigation"}'
```

### dom.get_html
Get raw HTML of an element. Defaults to `innerHTML`; set `outer: true` for `outerHTML`.
```bash
npx bb html el_abc123
npx bb call dom.get_html '{"elementRef":"el_abc123","outer":true,"maxLength":2000}'
```

### input.hover
Trigger CSS `:hover` state by dispatching `mouseenter`, `mouseover`, `mousemove`. Optional `duration` to hold hover before auto-releasing.
```bash
npx bb hover el_abc123
npx bb call input.hover '{"target":{"elementRef":"el_abc123"},"duration":1000}'
```

### input.drag
Full drag-and-drop sequence: `mousedown → dragstart → drag → dragenter → dragover → drop → dragend → mouseup`. Accepts source target, destination target, and optional pixel offsets.
```bash
npx bb call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"}}'
npx bb call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"sourceOffset":{"x":10,"y":10}}'
```

### tabs.create
Open a new browser tab. Optional `url` (defaults to `about:blank`) and `active` flag (defaults to `true`). Does not require a session.
```bash
npx bb tab-create https://example.com
npx bb call tabs.create '{"url":"https://example.com","active":false}'
```

### tabs.close
Close a tab by its `tabId`. Does not require a session.
```bash
npx bb tab-close 12345
npx bb call tabs.close '{"tabId":12345}'
```

### page.get_text
Extract the full visible text content of the page (`document.body.innerText`). Truncated to `textBudget` (default 4000 chars). Lighter than `dom.query` on `body` when you only need text.
```bash
npx bb page-text
npx bb page-text 8000
npx bb call page.get_text '{"textBudget":2000}'
```

### page.get_network
Read intercepted fetch/XHR requests. The interceptor is auto-installed on first call (via MAIN world script). Returns `{entries, count}` sorted newest-first.
```bash
npx bb network
npx bb network 50
npx bb call page.get_network '{"limit":20,"clear":true}'
```
Each entry: `{method, url, status, duration, initiator}`. Requires the `network.read` capability.

### dom.get_accessibility_tree
Retrieve the page's accessibility tree via CDP `Accessibility.getFullAXTree`. Each node is simplified to: `role`, `name`, `description`, `value`, `focused`, `required`, `checked`, `disabled`, `interactive`, `childIds`. Use `maxNodes` and `maxDepth` to control size.
```bash
npx bb a11y-tree
npx bb a11y-tree 50 3
npx bb call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5}'
```

### viewport.resize
Set the browser viewport to specific dimensions using CDP device emulation. Pass `reset: true` to clear the override.
```bash
npx bb resize 375 812
npx bb call viewport.resize '{"width":1024,"height":768}'
npx bb call viewport.resize '{"reset":true}'
```

### performance.get_metrics
Read Chrome performance counters via CDP `Performance.getMetrics`. Returns a flat `{metrics}` object with keys like `JSHeapUsedSize`, `LayoutCount`, `TaskDuration`, etc.
```bash
npx bb perf
npx bb call performance.get_metrics
```
Requires the `performance.read` capability.

## Request Envelope

```json
{"id":"req_1","session_id":"sess_abc","method":"dom.query","params":{},"meta":{"protocol_version":"1.0","token_budget":1200}}
```

## Error Codes

| Code | Action |
|------|--------|
| `ACCESS_DENIED` | User must enable tab in extension UI |
| `SESSION_EXPIRED` | Re-run `request-access` |
| `ORIGIN_MISMATCH` | Session bound to different origin |
| `CAPABILITY_MISSING` | Request capability not in session |
| `ELEMENT_STALE` | Re-query DOM for fresh `elementRef` |
| `NATIVE_HOST_UNAVAILABLE` | Check daemon: `npx bb status` |
| `APPROVAL_PENDING` | Wait + retry (see access retry flow) |
| `TIMEOUT` | Wait/evaluate exceeded `timeoutMs`; increase timeout or check condition |

Timeout on content-script request → use narrower `dom.query` or CDP fallback.
Timeout on navigation → increase `timeoutMs`, set `waitForLoad:false`, or check `page.get_state`.
Timeout on `dom.wait_for` → returns `{found: false}` (not an error); check selector/state logic.

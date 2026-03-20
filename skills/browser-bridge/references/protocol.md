# Protocol Reference

## All Methods (48)

| # | Method | Session? | Notes |
|---|--------|----------|-------|
| 1 | `tabs.list` | No | Discover available tabs |
| 2 | `session.request_access` | No | Create/reuse session (tab must be UI-enabled) |
| 3 | `session.get_status` | Yes | Confirm session validity |
| 4 | `session.revoke` | Yes | End session |
| 5 | `skill.get_runtime_context` | No | Live budget presets + method groups |
| 6 | `health.ping` | No | Bridge connectivity check |
| 7 | `log.tail` | No | Recent bridge logs |
| 8 | `page.get_state` | Yes | URL, readiness, focus, scroll, viewport |
| 9 | `page.evaluate` | Yes | Run JS expression in page context (CDP); requires `page.evaluate` capability |
| 10 | `page.get_console` | Yes | Buffered console messages; filter by `level`, `limit` entries |
| 11 | `page.wait_for_load_state` | Yes | Block until tab status is 'complete'; `timeoutMs` capped at 30 s |
| 12 | `page.get_storage` | Yes | Read `localStorage` or `sessionStorage`; optional `keys` filter |
| 13 | `navigation.navigate` | Yes | Go to URL; `waitForLoad` default true |
| 14 | `navigation.reload` | Yes | Reload; `waitForLoad` default true |
| 15 | `navigation.go_back` | Yes | History back |
| 16 | `navigation.go_forward` | Yes | History forward |
| 17 | `dom.query` | Yes | Query subtree with budget constraints |
| 18 | `dom.describe` | Yes | Single element details via `elementRef` |
| 19 | `dom.get_text` | Yes | Text content with `textBudget` |
| 20 | `dom.get_attributes` | Yes | Targeted attribute read |
| 21 | `dom.wait_for` | Yes | Wait for DOM condition (selector + optional text, state: attached/detached/visible/hidden); async with MutationObserver + polling |
| 22 | `dom.find_by_text` | Yes | Find elements by visible text content; returns `{nodes, count}` |
| 23 | `dom.find_by_role` | Yes | Find elements by ARIA role (explicit or implicit); optional `name` filter |
| 24 | `dom.get_html` | Yes | Get `innerHTML`/`outerHTML` of element; `maxLength` truncation |
| 25 | `layout.get_box_model` | Yes | Element geometry (no budget needed) |
| 26 | `layout.hit_test` | Yes | Element at viewport point |
| 27 | `styles.get_computed` | Yes | Computed CSS; always set `properties` |
| 28 | `styles.get_matched_rules` | Yes | Matching CSS rules |
| 29 | `viewport.scroll` | Yes | Window or element scroll |
| 30 | `input.click` | Yes | DOM-level click |
| 31 | `input.focus` | Yes | Focus element |
| 32 | `input.type` | Yes | Type text into input/textarea/contenteditable |
| 33 | `input.press_key` | Yes | Single key event |
| 34 | `input.set_checked` | Yes | Checkbox/radio toggle |
| 35 | `input.select_option` | Yes | Native select by value/label/index |
| 36 | `input.hover` | Yes | Dispatch mouseenter/mouseover/mousemove; optional `duration` ms to hold |
| 37 | `input.drag` | Yes | Full drag-and-drop event sequence (mousedown→dragstart→drag→drop→dragend) |
| 38 | `screenshot.capture_element` | Yes | Cropped element screenshot |
| 39 | `screenshot.capture_region` | Yes | Cropped viewport region |
| 40 | `patch.apply_styles` | Yes | Reversible CSS patch |
| 41 | `patch.apply_dom` | Yes | Reversible DOM mutation |
| 42 | `patch.list` | Yes | Active patches |
| 43 | `patch.rollback` | Yes | Revert one patch |
| 44 | `patch.commit_session_baseline` | Yes | Accept current state as baseline |
| 45 | `cdp.get_document` | Yes | DevTools document tree |
| 46 | `cdp.get_dom_snapshot` | Yes | DevTools DOM snapshot |
| 47 | `cdp.get_box_model` | Yes | DevTools-backed element geometry |
| 48 | `cdp.get_computed_styles_for_node` | Yes | DevTools-backed computed styles |

## CLI

```bash
npx bb status | logs | tabs | skill         # no session needed
npx bb request-access [tabId] [origin]       # create session
npx bb call <method> '{"key":"val"}'         # generic RPC (auto-session)
npx bb call <sessionId> <method> '{...}'     # explicit session
npx bb batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `session`, `revoke`, `eval`, `console`, `wait`, `find`, `find-role`, `html`, `hover`, `navigate`, `storage`

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

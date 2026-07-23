# Protocol Reference

Prefer non-debugger methods first. `chrome.debugger`-backed methods (marked **CDP** below) can cause Chrome to show its native "started debugging this browser" banner, so use them only when DOM/content-script methods cannot answer the question.

## Access Model

1. The user turns Browser Bridge on for one browser window.
2. Default routing follows the active tab in that enabled window.
3. Use `tabId` only when you intentionally need a different tab in the same enabled window.
4. Turning Browser Bridge off removes access immediately.

If a call fails with `ACCESS_DENIED`, `TAB_MISMATCH`, or a routing error: confirm the user enabled Browser Bridge for the correct window, confirm the page is not a Chrome-restricted page, and fall back to default routing when you do not need a specific tab.

## Target Shapes

Browser Bridge currently supports two target styles:

- `selector` at the top level for subtree discovery methods such as `dom.query`, `dom.find_by_text`, `dom.find_by_role`, and `dom.wait_for`
- `target: { elementRef, selector }` for interaction-oriented methods and, as a backward-compatible alias, for element-level reads such as `dom.describe`, `dom.get_text`, `dom.get_attributes`, `dom.get_html`, `layout.get_box_model`, `styles.get_computed`, `styles.get_matched_rules`, and `screenshot.capture_element`

Legacy top-level `elementRef` still works for element-level reads. Prefer `target` for new integrations when you want one consistent shape across reads and interactions.

## Capability Mapping

The table below includes the legacy capability bucket for each method so agents do not need to cross-reference a separate coverage page.

- `-` means the method is global/system-scoped and was never gated by a former capability bucket.
- Capability names are descriptive coverage labels only. Browser Bridge access is window-scoped now; there are no capability-scoped sessions.

## All Methods (66)

| Method                             | Tab? | CDP?       | Group       | Capability           | Notes                                                                                      |
| ---------------------------------- | ---- | ---------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `access.request`                   | No   | -          | system      | `intent?`            | Request window access with bounded operation context in the extension UI                    |
| `tabs.list`                        | No   | -          | tabs        | `-`                  | Discover tabs in the enabled window                                                        |
| `tabs.create`                      | No   | -          | tabs        | `tabs.manage`        | Open a new tab; optional `url` and `active`                                                |
| `tabs.close`                       | No   | -          | tabs        | `tabs.manage`        | Close a tab by `tabId`                                                                     |
| `tabs.activate`                    | No   | -          | tabs        | `tabs.manage`        | Bring a tab to the foreground in the enabled window                                        |
| `skill.get_runtime_context`        | No   | -          | system      | `-`                  | Live budget presets and method groups                                                      |
| `setup.get_status`                 | No   | -          | system      | `-`                  | Global MCP config and CLI skill install status                                             |
| `setup.install`                    | No   | -          | system      | `-`                  | Install or uninstall MCP/skill integration targets                                         |
| `health.ping`                      | No   | -          | system      | `-`                  | Connectivity, enabled-window routing, debugger, and capture state                          |
| `log.tail`                         | No   | -          | system      | `-`                  | Recent redacted bridge logs                                                                |
| `daemon.metrics`                   | No   | -          | system      | `-`                  | Daemon health and performance metrics                                                      |
| `page.get_state`                   | Yes  | -          | page        | `page.read`          | URL, readiness, focus, viewport, and observable dialog status                              |
| `page.evaluate`                    | Yes  | CDP        | page        | `page.evaluate`      | JS expression in page context; last resort                                                 |
| `page.get_console`                 | Yes  | -          | page        | `page.read`          | Buffered console messages; filter by `level`, `limit`                                      |
| `page.handle_dialog`               | Yes  | CDP        | page        | `navigation.control` | Inspect or explicitly accept/dismiss the currently observable dialog                       |
| `page.wait_for_load_state`         | Yes  | -          | wait        | `page.read`          | Wait for truthful tab `complete` state and/or a URL condition                              |
| `page.get_storage`                 | Yes  | -          | page        | `page.read`          | `localStorage`/`sessionStorage`; optional `keys`                                           |
| `page.get_text`                    | Yes  | -          | page        | `page.read`          | Full page text; `textBudget` limits size                                                   |
| `page.get_network`                 | Yes  | Conditional | page        | `network.read`       | Fetch/XHR by default; explicit CDP all-resource capture lifecycle                          |
| `network.intercept.add`            | Yes  | CDP        | page        | `network.intercept`  | Add interception rule; action fulfill/continue/block                                       |
| `network.intercept.remove`         | Yes  | CDP        | page        | `network.intercept`  | Remove rule by `ruleId`                                                                    |
| `network.intercept.list`           | Yes  | CDP        | page        | `network.intercept`  | List active rules (rules drop on debugger detach)                                          |
| `network.intercept.clear`          | Yes  | CDP        | page        | `network.intercept`  | Remove all rules and release interception                                                  |
| `navigation.navigate`              | Yes  | -          | navigate    | `navigation.control` | Go to URL; `waitForLoad` default true                                                      |
| `navigation.reload`                | Yes  | -          | navigate    | `navigation.control` | Reload; `waitForLoad` default true                                                         |
| `navigation.go_back`               | Yes  | -          | navigate    | `navigation.control` | History back                                                                               |
| `navigation.go_forward`            | Yes  | -          | navigate    | `navigation.control` | History forward                                                                            |
| `dom.query`                        | Yes  | -          | inspect     | `dom.read`           | Query subtree with budget constraints                                                      |
| `dom.describe`                     | Yes  | -          | inspect     | `dom.read`           | Single element details via `elementRef`                                                    |
| `dom.get_text`                     | Yes  | -          | inspect     | `dom.read`           | Text content with `textBudget`                                                             |
| `dom.get_attributes`               | Yes  | -          | inspect     | `dom.read`           | Targeted attribute read                                                                    |
| `dom.wait_for`                     | Yes  | -          | wait        | `dom.read`           | Wait for DOM condition; MutationObserver and polling                                       |
| `dom.find_by_text`                 | Yes  | -          | inspect     | `dom.read`           | Find by visible text; returns `{nodes, count}`                                             |
| `dom.find_by_role`                 | Yes  | -          | inspect     | `dom.read`           | Find by ARIA role; optional `name` filter                                                  |
| `dom.get_html`                     | Yes  | -          | inspect     | `dom.read`           | `innerHTML`/`outerHTML`; `maxLength` truncation                                            |
| `dom.get_accessibility_tree`       | Yes  | CDP        | inspect     | `dom.read`           | Depth-limited AX tree with compact/interactive filters and partial-topology metadata        |
| `layout.get_box_model`             | Yes  | -          | inspect     | `layout.read`        | Element geometry                                                                           |
| `layout.hit_test`                  | Yes  | -          | inspect     | `layout.read`        | Topmost element at viewport point                                                          |
| `styles.get_computed`              | Yes  | -          | inspect     | `styles.read`        | Requested properties; omission returns display/position/width/height/color                 |
| `styles.get_matched_rules`         | Yes  | -          | inspect     | `styles.read`        | Element ref, class list, and inline style only; not stylesheet cascade data                |
| `viewport.scroll`                  | Yes  | -          | navigate    | `viewport.control`   | Window or element scroll                                                                   |
| `viewport.resize`                  | Yes  | CDP        | navigate    | `viewport.control`   | Set viewport via device emulation; `reset: true`                                           |
| `input.click`                      | Yes  | Optional   | interact    | `automation.input`   | Actionability-aware DOM or CDP click                                                       |
| `input.focus`                      | Yes  | -          | interact    | `automation.input`   | Actionability-aware DOM focus                                                              |
| `input.type`                       | Yes  | Optional   | interact    | `automation.input`   | DOM key sequence or CDP text insertion                                                     |
| `input.fill`                       | Yes  | Optional   | interact    | `automation.input`   | DOM fill strategy or CDP clear/insert; see `mode` versus `executionMode`                   |
| `input.press_key`                  | Yes  | -          | interact    | `automation.input`   | DOM key event                                                                              |
| `input.set_checked`                | Yes  | -          | interact    | `automation.input`   | Checkbox/radio toggle                                                                      |
| `input.select_option`              | Yes  | -          | interact    | `automation.input`   | Native select by value/label/index                                                         |
| `input.hover`                      | Yes  | Optional   | interact    | `automation.input`   | DOM hover events or native CDP pointer move                                                |
| `input.drag`                       | Yes  | Optional   | interact    | `automation.input`   | DOM drag events or native interpolated pointer drag                                        |
| `input.scroll_into_view`           | Yes  | -          | interact    | `automation.input`   | Explicitly scroll target into view before inspect/capture                                  |
| `screenshot.capture_element`       | Yes  | CDP        | capture     | `screenshot.partial` | Cropped element screenshot                                                                 |
| `screenshot.capture_region`        | Yes  | CDP        | capture     | `screenshot.partial` | Cropped viewport region                                                                    |
| `screenshot.capture_full_page`     | Yes  | CDP        | capture     | `screenshot.partial` | Full document screenshot; only when page-level context is necessary                        |
| `patch.apply_styles`               | Yes  | -          | patch       | `patch.styles`       | Reversible CSS patch; `verify` returns computed result                                     |
| `patch.apply_dom`                  | Yes  | -          | patch       | `patch.dom`          | Reversible DOM mutation; `verify` returns result                                           |
| `patch.list`                       | Yes  | -          | patch       | `patch.dom`          | Active rollback records in the current document                                            |
| `patch.rollback`                   | Yes  | -          | patch       | `patch.dom`          | Revert one active patch                                                                    |
| `patch.commit_session_baseline`    | Yes  | -          | patch       | `patch.dom`          | Keep current mutations and discard their rollback history                                  |
| `performance.get_metrics`          | Yes  | CDP        | performance | `performance.read`   | Chrome performance counters                                                                |
| `cdp.get_document`                 | Yes  | CDP        | cdp         | `cdp.dom_snapshot`   | DevTools document tree                                                                     |
| `cdp.get_dom_snapshot`             | Yes  | CDP        | cdp         | `cdp.dom_snapshot`   | DevTools DOM snapshot                                                                      |
| `cdp.get_box_model`                | Yes  | CDP        | cdp         | `cdp.box_model`      | DevTools-backed element geometry                                                           |
| `cdp.get_computed_styles_for_node` | Yes  | CDP        | cdp         | `cdp.styles`         | DevTools-backed computed styles                                                            |
| `cdp.dispatch_key_event`           | Yes  | CDP        | cdp         | `cdp.input`          | DevTools keyDown/keyUp without foreground focus                                            |

## CLI

```bash
bbx status | doctor | restart | logs | tabs | skill # no routed tab needed
bbx call <method> '{"key":"val"}'           # generic RPC (routes to active tab in enabled window)
bbx call --tab 123 <method> '{...}'         # explicit tab target inside enabled window
bbx batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `access-request`, `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `cdp-press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `eval`, `console`, `wait`, `find`, `find-role`, `html`, `hover`, `navigate`, `storage`, `tab-create`, `tab-close`, `page-text`, `network`, `a11y-tree`, `perf`, `scroll`, `resize`, `reload`, `back`, `forward`, `attrs`, `matched-rules`

Newer bridge methods such as `input.scroll_into_view` and `screenshot.capture_full_page` currently use the raw path: `bbx call <method> '{...}'`.

## Method Details

### access.request

Request Browser Bridge access for the focused browser window. Surfaces an Enable prompt in the extension popup or side panel with the reported source, bounded operation intent, tab title, and sanitized origin. Does not require existing access.

```bash
bbx access-request
bbx access-request inspect
bbx call access.request '{"intent":"capture"}'
```

`intent` is optional and defaults to `general`. Accepted values are `inspect`, `interact`, `capture`, `navigate`, `debugger`, and `general`; arbitrary prompt text is rejected. The source and intent are reported context, while the title and origin are resolved and sanitized by the extension.

If a tab-bound call returns `ACCESS_DENIED`, it also surfaces the Enable prompt automatically - so explicit `access.request` is optional but useful for proactive setup.

If access is already pending for a window, do not call `access.request` again. Ask the user to click `Enable` for the requested window and wait for confirmation before continuing.

### page.evaluate

Run a JS expression in the page context via CDP `Runtime.evaluate`. Expression is evaluated as a statement and the return value is serialized. Supports `awaitPromise` for async expressions.

Use only when non-debugger reads are insufficient. Prefer `page.get_storage`, `page.get_text`, `page.get_console`, `page.get_network`, or DOM methods first.

```bash
bbx eval 'document.title'
bbx eval 'window.__NEXT_DATA__.props'
bbx call page.evaluate '{"expression":"await fetch(\"/api/health\").then(r=>r.json())","awaitPromise":true}'
```

### page.get_console

Read buffered console output. The console interceptor is auto-installed on first call. Captures `log`, `warn`, `error`, `info`, `debug` plus uncaught exceptions and unhandled rejections. `level` is a minimum severity, so `warn` includes errors, exceptions, and rejections; `exception` and `rejection` select only that exact stream.

To capture a reproduction reliably, call it once with `clear: true` before triggering the event. This installs the interceptor and removes older entries. Reproduce the issue, then read again without `clear`.

```bash
bbx console                    # all levels
bbx console error              # errors only
bbx call page.get_console '{"level":"error","limit":20,"clear":true}'
```

Responses include `dropped` when older buffered entries were discarded on noisy pages.

### page.handle_dialog

Inspecting is read-only; accepting or dismissing must be explicit. `promptText` is valid only with `action: "accept"`. An optional `expectedDialogId` checks that the current observation still matches immediately before dispatch, but Chrome's `Page.handleJavaScriptDialog` command cannot atomically bind to that identifier. A successful mutation therefore reports `commandDispatched: true` and `atomicDialogBinding: false`; it does not prove which application follow-up occurred.

```bash
bbx call page.handle_dialog '{"action":"inspect"}'
bbx call page.handle_dialog '{"action":"accept","expectedDialogId":"00000000-0000-4000-8000-000000000000:1","promptText":"value"}' # replace with inspected dialogId
bbx call page.handle_dialog '{"action":"dismiss","expectedDialogId":"00000000-0000-4000-8000-000000000000:1"}' # replace with inspected dialogId
```

`DIALOG_NOT_OPEN` means no current dialog was observable. `DIALOG_ACTION_CONFLICT` means the observation changed before or around dispatch; inspect again and never automatically repeat the mutating action. Dialog messages and prompt defaults are bounded and excluded from persisted action logs.

### page.wait_for_load_state

Wait for truthful Chrome tab `complete` status, a URL condition, or both. URL waits check the current URL first, then observe tab updates plus `pushState`, `replaceState`, `popstate`, and hash changes. Results include `finalUrl`, `urlMatch`, `elapsedMs`, and `observedNavigationKind`; this method does not call DOMContentLoaded behavior `networkidle`.

```bash
bbx call page.wait_for_load_state '{"timeoutMs":10000}'
bbx call page.wait_for_load_state '{"url":"/dashboard","urlMatch":"contains","waitForLoad":false}'
```

`urlMatch: "regex"` accepts at most 256 characters and only a bounded linear subset: literals, escapes, anchors, dots, and character classes. Grouping, alternation, quantifiers, and backreferences are rejected.

### page.get_storage

Read `localStorage` or `sessionStorage` entries. Values truncated at 500 chars each.

```bash
bbx storage                        # all localStorage
bbx storage session token,user     # specific sessionStorage keys
bbx call page.get_storage '{"type":"session","keys":["token"]}'
```

### dom.query

Run a bounded breadth-first DOM summary rooted at a selector or existing ref. Returns `{nodes, revision, truncated, registrySize}` and may also include `_registryPruned: true` when the element registry evicted older refs.

```bash
bbx dom-query main
bbx call dom.query '{"selector":"main","maxNodes":10,"attributeAllowlist":["class","data-testid"]}'
```

If `_registryPruned` is true, refresh previously cached refs before reusing them.

### dom.wait_for

Wait for a DOM condition using MutationObserver + 250 ms polling fallback. A text-only wait searches all elements. `hidden` succeeds when no matching visible element remains, including when it is absent. Returns `{found, elementRef, duration}`.

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
bbx call dom.find_by_text '{"text":"Submit","selector":"button","exact":false}'
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

### styles.get_computed and styles.get_matched_rules

When `properties` is omitted, `styles.get_computed` returns exactly `display`, `position`, `width`, `height`, and `color`. Pass an explicit list for any other properties. `styles.get_matched_rules` currently returns only `{elementRef, classes, inlineStyle}`; it does not inspect stylesheet rules, specificity, or cascade order.

### Actionable input targets

Input calls preserve an explicit `elementRef`. For selectors, the first actionable match wins; if it is not actionable, Browser Bridge evaluates at most 25 matches and chooses only a uniquely better candidate. It scrolls the selected target if needed and rechecks visibility, disabled/inert state, rendered bounds, and pointer hit testing before dispatch. Failures use `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_ACTIONABLE`, `ELEMENT_OBSCURED`, or `ELEMENT_AMBIGUOUS` with bounded details.

Successful targeted click, focus, type, fill, press-key, checked-state, option-selection, hover, and drag results include `resolution` (`strategy`, candidate/evaluated counts, scrolling, hit test, and recovery fields) and `execution` (`requestedMode`, `actualMode`, `fallbackReason`, `debuggerUsed`, and coordinates). `cdp.dispatch_key_event`/MCP `cdp_press_key` and `input.scroll_into_view` use separate response contracts. `executionMode` is the dispatch path and accepts only `dom` or `cdp`, defaulting to `dom` for compatibility. CDP is supported only by click, hover, drag, type, and fill; unsupported combinations return `INPUT_UNSUPPORTED` instead of falling back silently.

`input.fill.mode` is separate: `auto`, `setter`, and `keystrokes` choose the DOM fill strategy. `mode: "auto"` may fall back from the setter to keystrokes and reports the used `mode`; it does not select CDP. With `executionMode: "cdp"`, fill uses native clear/text dispatch and reports `mode: "cdp"`.

Stale refs still fail by default. `recoverStale: true` permits one strict recovery attempt only within the current document and unchanged URL, based on a strong unique descriptor such as test ID, ID, role/name, label, or href plus semantic context. Recovery evaluates at most 100 same-tag candidates. If more exist, it returns `ELEMENT_AMBIGUOUS` with `reason: "scan_incomplete"` because uniqueness is not provable, even when the evaluated prefix contains one match. Ambiguous, weak, or changed-URL recovery also fails. Recovered results identify old/new refs and matched fields.

Browser input dispatch is not a generic application-state assertion. Follow each action with the cheapest relevant `dom.wait_for`, `page.wait_for_load_state`, `dom.describe`, or other structured read.

### input.hover

Trigger hover with DOM events by default, or a native pointer move with `executionMode: "cdp"`. Optional `duration` waits before returning; it does not promise a persistent hover after the call.

```bash
bbx hover el_abc123
bbx call input.hover '{"target":{"elementRef":"el_abc123"},"duration":1000}'
```

### input.drag

The DOM path dispatches `mousedown → dragstart → drag → dragenter → dragover → drop → dragend → mouseup`. The CDP path performs a bounded interpolated native pointer drag and guarantees a release attempt after failure. Both accept source, destination, and optional destination offsets.

```bash
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"}}'
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"offsetX":10,"offsetY":10}'
```

### input.scroll_into_view

Explicitly scroll an element into the visible viewport before inspecting, hovering, or capturing it.

```bash
bbx call input.scroll_into_view '{"target":{"elementRef":"el_abc123"}}'
bbx call input.scroll_into_view '{"target":{"selector":"[data-testid=\\"checkout-summary\\"]"}}'
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

The fetch/XHR interceptor is installed on the first call. Before reproducing a network issue, call `page.get_network` with `clear: true`, trigger the action, then read the buffer again without `clear` so the relevant request is not missed or erased.

The default `source: "fetch-xhr"` path auto-installs MAIN-world instrumentation on first call and returns completed entries in capture order (oldest to newest among the retained/limited entries). Prime with `clear: true`, reproduce, then read without clearing.

```bash
bbx network
bbx network 50
bbx call page.get_network '{"limit":20,"clear":true}'
```

Each fetch/XHR entry is `{method, url, status, duration, type, ts, size}`. Responses also include `count`, `total`, `filteredTotal`, `source`, `captureState: "instrumented"`, `dropped`, and limit truncation metadata.

For optional all-resource metadata, use the explicit debugger-backed CDP lifecycle. Start clears prior state and holds debugger ownership until stop (or the 10-minute safety expiry); read does not retroactively capture events:

```bash
bbx call page.get_network '{"source":"cdp","capture":"start"}'
# reproduce the activity
bbx call page.get_network '{"source":"cdp","capture":"read","limit":50}'
bbx call page.get_network '{"source":"cdp","capture":"stop"}'
```

`capture: "clear"` clears completed/in-flight entries while leaving an armed capture running. CDP entries contain `requestId`, redacted `url`, `method`, `resourceType`, `status`, `mimeType`, `protocol`, cache flags, bounded redirect summary, `failureReason`, `duration`, and `timestamp`. Result lifecycle fields include `armed`, `armedDuringCapture`, `captureState`, `ownershipHeld`, `startedAt`, `inflight`, `dropped`, and `abandoned`.

CDP URL output removes credentials and fragments, replaces every query value with `[redacted]`, and summarizes data/blob URLs. Request/response bodies, cookies, authorization values, and complete headers are not returned. This mode captures all observed resource classes and is materially more expensive and intrusive than fetch/XHR instrumentation; always stop it when finished.

### dom.get_accessibility_tree

Retrieve a depth-limited accessibility tree via CDP `Accessibility.getFullAXTree`. Nodes include `role`, `name`, `description`, `value`, state fields, `interactive`, `semanticInteractive`, `focusable`, `focusableAndEnabled`, `ignored`, and `childIds`. `interactive` is semantic/focusability metadata, not current pointer actionability.

This is debugger-backed. Prefer `dom.find_by_role`, `dom.find_by_text`, and targeted `dom.query`/`dom.describe` first.

```bash
bbx a11y-tree
bbx a11y-tree 50 3
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5,"compact":true}'
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":6,"interactiveOnly":true}'
```

Filtering occurs before `maxNodes`. Compact mode drops ignored, decorative, and empty nodes while reconnecting retained descendants; interactive-only keeps non-ignored semantic interactive roles. Because CDP applies `maxDepth` before Browser Bridge receives the tree, every result truthfully reports `truncated: true`, `partialTopology: true`, depth metadata, missing-child counts, and a continuation hint. No AX node is written into the page DOM or converted directly into an actionable element ref; use role/name with `dom.find_by_role` before input.

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

### screenshot.capture_full_page

Capture a full-document screenshot beyond the current viewport. Use only when element or tight region captures cannot express the issue. Chrome capture limits still apply on very large pages.

This raw call returns base64 JSON. Prefer `bbx screenshot <ref> [outPath]` when one element is enough.

```bash
bbx call screenshot.capture_full_page '{}'
```

## Request Envelope

```json
{
  "id": "req_1",
  "tab_id": 123,
  "method": "dom.query",
  "params": {},
  "meta": { "protocol_version": "<package major.minor>", "token_budget": 1200 }
}
```

## Error Codes

| Code                         | Action                                                         | Recovery                                     |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `ACCESS_DENIED`              | Turn on Browser Bridge for the target window                   | `retry: false`                               |
| `TAB_MISMATCH`               | Explicit `tabId` is missing, closed, or outside enabled window | `retry: false`, use `tabs.list`              |
| `ELEMENT_STALE`              | Re-query DOM for fresh `elementRef`                            | `retry: false`, use `dom.query`              |
| `ELEMENT_AMBIGUOUS`          | Narrow selector or use an explicit ref                         | `retry: false`, use `dom.query`              |
| `ELEMENT_NOT_ACTIONABLE`     | Inspect hidden/disabled/inert/zero-size target                 | `retry: false`, use `dom.describe`           |
| `ELEMENT_OBSCURED`           | Inspect the element blocking the target point                  | `retry: false`, use `layout.hit_test`        |
| `ELEMENT_NOT_FOUND`          | Correct or narrow the selector                                 | `retry: false`, use `dom.query`              |
| `INPUT_UNSUPPORTED`          | Use DOM execution or a CDP-supported input method              | `retry: false`                               |
| `INPUT_INVALID_TARGET`       | Choose a control compatible with the input                     | `retry: false`, use `dom.describe`           |
| `INPUT_FOCUS_CHANGED`        | Inspect focus handlers; do not replay native text blindly      | `retry: false`, use `dom.describe`           |
| `DIALOG_NOT_OPEN`            | Trigger or inspect the current dialog                          | `retry: false`                               |
| `DIALOG_ACTION_CONFLICT`     | Inspect again; never auto-repeat a dialog mutation              | `retry: false`                               |
| `CONTENT_SCRIPT_UNAVAILABLE` | Page is restricted (chrome://, extensions, etc.)               | `retry: false`                               |
| `NATIVE_HOST_UNAVAILABLE`    | Check daemon: `bbx status`                                     | `retry: false`                               |
| `EXTENSION_DISCONNECTED`     | Extension not connected to daemon                              | `retry: true` after 3 s, check `health.ping` |
| `TIMEOUT`                    | Wait/evaluate exceeded `timeoutMs`                             | `retry: true` after 1 s                      |
| `RATE_LIMITED`               | Too many requests                                              | `retry: true` after 2 s                      |

Timeout on content-script request → use narrower `dom.query` or CDP fallback.
Timeout on navigation → increase `timeoutMs`, set `waitForLoad:false`, or check `page.get_state`.
Timeout on `dom.wait_for` → returns `{found: false}` (not an error); check selector/state logic.

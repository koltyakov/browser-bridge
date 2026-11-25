# Protocol Reference

Prefer non-debugger methods first. `chrome.debugger`-backed methods (marked **CDP** below) can cause Chrome to show its native "started debugging this browser" banner, so use them only when DOM/content-script methods cannot answer the question.

## Access Model

1. The user turns Browser Bridge on for one browser window.
2. The first page call binds to the active tab in that enabled window. Later calls keep the working tab when the user switches tabs. You may activate tabs you opened for this task while the active tab is also in use for this task; check active state first. Otherwise, target background tabs without activating them unless the user requests or permits activation. If background work requires activation, explain why and ask.
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

Use `bbx protocol describe <method|group>` for a compact local signature lookup. In MCP mode,
call `browser_call` with method `protocol.describe` and params containing `method` or `group`;
omit both for the group index.

Use `protocol.describe` with `{query:"fill editable",limit:5}` to search trusted
RPC names/descriptions. Optional `group` filters results; follow
`pagination.nextOffset`. Search returns canonical generated RPC signatures,
not additional host tool paths. Load one exact method for its schema.

Use `protocol.capabilities` with `{calls:[{method:"input.fill"}],executionMode:"cdp",frameId:0}`
and the selected extensionId/tabId for an advisory eligibility snapshot.
`available` is not actionability, permission or success. `unavailable` includes
a known reason; `unknown` requires further inspection. It never activates tabs
or attaches the debugger, and all dispatch-time checks still apply. Child-frame
actions still use frame-owned refs or ordinary locator routing.

## All methods

| Method                             | Tab? | CDP?       | Group       | Capability           | Notes                                                                                      |
| ---------------------------------- | ---- | ---------- | ----------- | -------------------- | ------------------------------------------------------------------------------------------ |
| `access.request`                   | No   | -          | system      | `intent?`            | Request window access with bounded operation context in the extension UI                    |
| `access.wait_for_change`           | No   | -          | system      | `revision, timeoutMs?` | Wait up to 25 seconds for a user access-setting revision change, without replaying an action |
| `protocol.describe`                | No   | -          | system      | `-`                  | Bounded literal RPC search; exact method loads schema and generated signature |
| `protocol.capabilities`            | No   | -          | system      | `-`                  | Advisory eligibility for 1..32 calls under the selected tab, mode, frame and grant |
| `tabs.list`                        | No   | -          | tabs        | `-`                  | Discover tabs in the enabled window                                                        |
| `tabs.create`                      | No   | -          | tabs        | `tabs.manage`        | Open a new tab; optional `url`, `active`, and `idleTtlMs` (idle auto-close)                |
| `tabs.close`                       | No   | -          | tabs        | `tabs.manage`        | Close a tab by `tabId`                                                                     |
| `tabs.activate`                    | No   | -          | tabs        | `tabs.manage`        | Bring a tab to the foreground in the enabled window                                        |
| `skill.get_runtime_context`        | No   | -          | system      | `-`                  | Live budget presets and method groups                                                      |
| `setup.get_status`                 | No   | -          | system      | `-`                  | Global MCP config and CLI skill install status                                             |
| `setup.install`                    | No   | -          | system      | `-`                  | Install or uninstall MCP/skill integration targets                                         |
| `health.ping`                      | No   | -          | system      | `diagnostics?`       | Compact connectivity, compatibility, and routing; `diagnostics: true` adds the full report |
| `log.tail`                         | No   | -          | system      | `-`                  | Recent redacted bridge logs                                                                |
| `daemon.metrics`                   | No   | -          | system      | `-`                  | Daemon health, performance, and process-local recovery metrics                              |
| `page.get_state`                   | Yes  | -          | page        | `page.read`          | URL, readiness, focus, viewport, and observable dialog status                              |
| `page.evaluate`                    | Yes  | CDP        | page        | `page.evaluate`      | JS expression in page context; last resort                                                 |
| `page.get_console`                 | Yes  | -          | page        | `page.read`          | Buffered console messages and error stacks; filter by `level`, `limit`; `resolveSources` maps frames through source maps |
| `page.handle_dialog`               | Yes  | CDP        | page        | `navigation.control` | Inspect or explicitly accept/dismiss the currently observable dialog                       |
| `page.wait_for_load_state`         | Yes  | -          | wait        | `page.read`          | Wait for truthful tab `complete` state and/or a URL condition                              |
| `page.get_storage`                 | Yes  | -          | page        | `page.read`          | Bounded storage keys or IndexedDB metadata; optional `keys`; never values          |
| `sensitive.read`                   | Yes  | -          | sensitive   | `sensitive.read`     | One storage key, or gated body or IndexedDB record; sequential, whole-or-error     |
| `page.get_text`                    | Yes  | -          | page        | `page.read`          | Full page text; `textBudget` limits size, `offset` continues a truncated read              |
| `page.extract_content`             | Yes  | -          | page        | `page.read`          | Node-processed semantic text/Markdown with bounded HTML snapshots and optional settlement   |
| `page.get_network`                 | Yes  | Conditional | page        | `network.read`       | Fetch/XHR by default; explicit CDP all-resource capture lifecycle                          |
| `network.export_har`               | Yes  | No*        | page        | `network.read`       | Read an already armed CDP capture as bounded metadata-only HAR 1.2                         |
| `network.intercept.add`            | Yes  | CDP        | page        | `network.intercept`  | Add interception rule; action fulfill/continue/block                                       |
| `network.intercept.remove`         | Yes  | CDP        | page        | `network.intercept`  | Remove rule by `ruleId`                                                                    |
| `network.intercept.list`           | Yes  | CDP        | page        | `network.intercept`  | List active rules (rules drop on debugger detach)                                          |
| `network.intercept.clear`          | Yes  | CDP        | page        | `network.intercept`  | Remove all rules and release interception                                                  |
| `navigation.navigate`              | Yes  | -          | navigate    | `navigation.control` | Go to URL; `waitForLoad` default true                                                      |
| `navigation.reload`                | Yes  | -          | navigate    | `navigation.control` | Reload; `waitForLoad` default true                                                         |
| `navigation.go_back`               | Yes  | -          | navigate    | `navigation.control` | History back                                                                               |
| `navigation.go_forward`            | Yes  | -          | navigate    | `navigation.control` | History forward                                                                            |
| `dom.query`                        | Yes  | -          | inspect     | `dom.read`           | Query subtree with budget constraints                                                      |
| `dom.baseline.create`              | Yes  | -          | inspect     | `dom.read`           | Retain a short-lived memory-only semantic snapshot; sequential only                        |
| `dom.baseline.compare`             | Yes  | -          | inspect     | `dom.read`           | Compare current semantic DOM to an explicit retained baseline; batch-safe                  |
| `dom.baseline.describe`            | Yes  | -          | inspect     | `dom.read`           | Return exact baseline scope, options, expiry, and snapshot statistics; batch-safe          |
| `dom.baseline.release`             | Yes  | -          | inspect     | `dom.read`           | Idempotently release retained baseline state; sequential only                              |
| `screenshot.baseline.create`       | Yes  | -          | capture     | `screenshot.partial` | Opt-in scoped visual reference when DOM diffs are insufficient; memory-only, sequential    |
| `screenshot.baseline.compare`      | Yes  | -          | capture     | `screenshot.partial` | Exact Go comparison, context-expanded before/after evidence; sequential                     |
| `screenshot.baseline.release`      | Yes  | -          | capture     | `screenshot.partial` | Idempotently release visual pixels; sequential                                               |
| `dom.describe`                     | Yes  | -          | inspect     | `dom.read`           | Single element details via `elementRef`                                                    |
| `dom.get_text`                     | Yes  | -          | inspect     | `dom.read`           | Text content with `textBudget`                                                             |
| `dom.get_attributes`               | Yes  | -          | inspect     | `dom.read`           | Targeted attribute read                                                                    |
| `dom.wait_for`                     | Yes  | -          | wait        | `dom.read`           | Wait for DOM condition; MutationObserver and polling                                       |
| `dom.find_by_text`                 | Yes  | -          | inspect     | `dom.read`           | Find by visible text; returns `{nodes, count}`                                             |
| `dom.find_by_role`                 | Yes  | -          | inspect     | `dom.read`           | Find by ARIA role; optional `name` filter                                                  |
| `dom.get_html`                     | Yes  | -          | inspect     | `dom.read`           | `innerHTML`/`outerHTML`; `maxLength` truncation                                            |
| `dom.get_accessibility_tree`       | Yes  | CDP / none | inspect     | `dom.read`           | AX tree (CDP) or `source: "dom"` actionable outline with refs, no debugger                 |
| `layout.get_box_model`             | Yes  | -          | inspect     | `layout.read`        | Element geometry                                                                           |
| `layout.hit_test`                  | Yes  | -          | inspect     | `layout.read`        | Topmost element at viewport point                                                          |
| `styles.get_computed`              | Yes  | -          | inspect     | `styles.read`        | Requested properties; omission returns display/position/width/height/color                 |
| `styles.get_matched_rules`         | Yes  | -          | inspect     | `styles.read`        | Element ref, class list, and inline style only; not stylesheet cascade data                |
| `viewport.scroll`                  | Yes  | -          | navigate    | `viewport.control`   | Window or element scroll                                                                   |
| `viewport.resize`                  | Yes  | CDP        | navigate    | `viewport.control`   | Set viewport via device emulation; `reset: true`                                           |
| `input.click`                      | Yes  | Optional   | interact    | `automation.input`   | Actionability-aware DOM or CDP click; `holdMs` keeps the button pressed                    |
| `input.focus`                      | Yes  | -          | interact    | `automation.input`   | Actionability-aware DOM focus                                                              |
| `input.type`                       | Yes  | Optional   | interact    | `automation.input`   | DOM key sequence or CDP text insertion                                                     |
| `input.fill`                       | Yes  | Optional   | interact    | `automation.input`   | DOM fill strategy or CDP clear/insert; see `mode` versus `executionMode`                   |
| `input.press_key`                  | Yes  | Optional   | interact    | `automation.input`   | DOM key events (with `code`/`keyCode`) or trusted CDP key pair; `holdMs`                   |
| `input.set_checked`                | Yes  | -          | interact    | `automation.input`   | Checkbox/radio toggle                                                                      |
| `input.select_option`              | Yes  | -          | interact    | `automation.input`   | Native select by value/label/index                                                         |
| `input.hover`                      | Yes  | Optional   | interact    | `automation.input`   | DOM hover events or native CDP pointer move                                                |
| `input.drag`                       | Yes  | Optional   | interact    | `automation.input`   | HTML5 drag for draggable sources, pointer drag otherwise; or native CDP pointer drag       |
| `input.touch`                      | Yes  | Optional   | interact    | `automation.input`   | 1-10 simultaneous touch points (chords, taps, swipes, pinches) held for `holdMs`           |
| `input.perform`                    | Yes  | Per step   | interact    | `automation.input`   | Ordered, timed sequence of input steps executed inside the extension                       |
| `input.scroll_into_view`           | Yes  | -          | interact    | `automation.input`   | Explicitly scroll target into view before inspect/capture                                  |
| `screenshot.capture_element`       | Yes  | CDP        | capture     | `screenshot.partial` | Complete element screenshot with explicit completeness metadata                            |
| `screenshot.capture_region`        | Yes  | CDP        | capture     | `screenshot.partial` | Cropped viewport region in PNG, JPEG, or WebP                                               |
| `screenshot.capture_full_page`     | Yes  | CDP        | capture     | `screenshot.partial` | Full document screenshot; fails coherently above Chrome capture limits                     |
| `artifact.read`                    | No   | daemon     | raw         | None                 | Read one bounded chunk from an owner-scoped artifact handle                                 |
| `artifact.delete`                  | No   | daemon     | raw         | None                 | Delete an owner-scoped artifact handle                                                      |
| `patch.apply_styles`               | Yes  | -          | patch       | `patch.styles`       | Reversible CSS patch; `verify` returns computed result                                     |
| `patch.apply_dom`                  | Yes  | -          | patch       | `patch.dom`          | Reversible text, attribute, add/remove/toggle-class mutation; `verify` returns result       |
| `patch.list`                       | Yes  | -          | patch       | `patch.dom`          | Active rollback records in the current document                                            |
| `patch.rollback`                   | Yes  | -          | patch       | `patch.dom`          | Revert one active patch                                                                    |
| `patch.commit_session_baseline`    | Yes  | -          | patch       | `patch.dom`          | Keep current mutations and discard their rollback history                                  |
| `performance.get_metrics`          | Yes  | CDP        | performance | `performance.read`   | Chrome performance counters                                                                |
| `cdp.get_document`                 | Yes  | CDP        | cdp         | `cdp.dom_snapshot`   | DevTools document tree                                                                     |
| `cdp.get_dom_snapshot`             | Yes  | CDP        | cdp         | `cdp.dom_snapshot`   | DevTools DOM snapshot; optional bounded `computedStyles` property names                     |
| `cdp.get_box_model`                | Yes  | CDP        | cdp         | `cdp.box_model`      | DevTools-backed element geometry                                                           |
| `cdp.get_computed_styles_for_node` | Yes  | CDP        | cdp         | `cdp.styles`         | DevTools-backed computed styles                                                            |
| `cdp.dispatch_key_event`           | Yes  | CDP        | cdp         | `cdp.input`          | DevTools keyDown/keyUp without foreground focus                                            |
| `webmcp.list_tools` | Yes | - | webmcp | `page.read` | Bounded top-document website tool summaries; optional query/pagination |
| `webmcp.get_tool` | Yes | - | webmcp | `page.read` | Complete atomic schema by document/session-bound toolRef |
| `webmcp.execute_tool` | Yes | - | webmcp | `automation.input` | Exact-argument extension approval; never batched or automatically retried |

`No*` means HAR export issues no CDP command itself, but its source capture must
already be armed and continues to hold debugger ownership until explicitly
stopped.

## CLI

```bash
bbx status | doctor | restart | logs | tabs | skill # no routed tab needed
bbx protocol describe [method|group]             # local signature or compact group index
bbx call <method> '{"key":"val"}'           # generic RPC (routes to the session's working tab)
bbx call --tab 123 <method> '{...}'         # explicit tab target inside enabled window
bbx batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `access-request`, `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `cdp-press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `har`, `eval`, `console`, `wait`, `find`, `find-role`, `html`, `hover`, `navigate`, `storage`, `tab-create`, `tab-close`, `page-text`, `network`, `a11y-tree`, `perf`, `scroll`, `resize`, `reload`, `back`, `forward`, `attrs`, `matched-rules`

Newer bridge methods such as `input.scroll_into_view` and `screenshot.capture_full_page` currently use the raw path: `bbx call <method> '{...}'`.

## Method Details

Per-method parameters, limits, and examples live in `method-details.md`.

## Recovery Telemetry

Recovery telemetry is process-local and uses fixed five-second buckets over a
five-minute window. Three failures for the same hidden group within 60 seconds
set `activeLoop` for that category. Public summaries always use only these fixed
categories: `automatic_mcp_retry`, `stale_ref_recovery`, `debugger_reattach`,
`content_script_reinjection`, `native_host_reconnect`, and `request_outcome`.
They contain attempts/successes/failures/pending, bounded rates, saturation,
last-event timestamps, and loop flags, but no page data, URL, selector, payload,
error text, method name, tab identifier, or internal group name.

`health.ping` with `diagnostics: true` includes daemon and available routed-extension summaries;
`daemon.metrics` includes daemon scope. `bbx doctor` combines both, marks active
loops as issues, and emits fixed guidance. Stop repeated attempts: re-query stale
refs, close competing debuggers, reload extension/page after reinjection
failures, restart for native-host reconnect failures, stop automatic MCP retry
loops, or inspect the first typed error for request failures. Extension data
resets with the service worker and daemon data resets with the daemon.

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

Apply the [skill's retry rules](../SKILL.md#troubleshooting) before interpreting
code-level recovery defaults. `retry: false` forbids automatic retry, and
`retry: true` never authorizes replay of a possibly dispatched mutation.
MCP already performs bounded recovery for eligible safe reads. Local MCP errors
without a confirmed result instead report `outcomeUncertain: true`, `retry: false`,
and no retry backoff; they do not establish partial progress or dispatch state.

| Code                         | Action                                                         | Recovery                                     |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| `ACCESS_DENIED`              | Follow the access flow or policy-setting denial; do not bypass it | No automatic retry; deliberately retry only an undispatched operation after permission changes |
| `TAB_MISMATCH`               | Explicit `tabId` is missing, closed, or outside enabled window | `retry: false`, use `tabs.list`              |
| `ELEMENT_STALE`              | Re-query DOM for fresh `elementRef`                            | `retry: false`, use `dom.query`              |
| `ELEMENT_AMBIGUOUS`          | Narrow selector or use an explicit ref                         | `retry: false`, use `dom.query`              |
| `ELEMENT_NOT_ACTIONABLE`     | Inspect hidden/disabled/inert/zero-size target                 | `retry: false`, use `dom.describe`           |
| `ELEMENT_OBSCURED`           | Inspect the element blocking the target point                  | `retry: false`, use `layout.hit_test`        |
| `ELEMENT_NOT_FOUND`          | Correct or narrow the selector                                 | `retry: false`, use `dom.query`              |
| `DOM_BASELINE_NOT_FOUND`     | Handle expired, released, evicted, or does not exist           | `retry: false`, create a new baseline        |
| `DOM_BASELINE_INVALIDATED`   | Navigation, document, or access scope changed                  | `retry: false`, create a new baseline        |
| `DOM_BASELINE_QUOTA_EXCEEDED` | Snapshot or retained-state quota was exceeded                 | `retry: false`, narrow selector or release   |
| `INPUT_UNSUPPORTED`          | Use DOM execution or a CDP-supported input method              | `retry: false`                               |
| `INPUT_INVALID_TARGET`       | Choose a control compatible with the input                     | `retry: false`, use `dom.describe`           |
| `INPUT_FOCUS_CHANGED`        | Inspect focus handlers; do not replay native text blindly      | `retry: false`, use `dom.describe`           |
| `INPUT_VALUE_REJECTED`       | Fill a value in `details.expectedFormat` or inspect the mask   | `retry: false`, use `dom.describe`           |
| `EVALUATION_FAILED` | Fix the expression; the page may have run part of it | `retry: false` |
| `REQUEST_CANCELED` | Inspect postconditions before retrying a mutation | `retry: false` |
| `BRIDGE_BUSY` | Retry after `retryAfterMs` | `retry: true` |
| `DAEMON_UNAVAILABLE` | Retry once; then run `bbx doctor` | `retry: true` |
| `DIALOG_NOT_OPEN`            | Trigger or inspect the current dialog                          | `retry: false`                               |
| `DIALOG_ACTION_CONFLICT`     | Inspect again; never auto-repeat a dialog mutation              | `retry: false`                               |
| `CONTENT_SCRIPT_UNAVAILABLE` | Page is restricted (chrome://, extensions, etc.)               | `retry: false`                               |
| `NATIVE_HOST_UNAVAILABLE`    | Check daemon: `bbx status`                                     | `retry: false`                               |
| `EXTENSION_DISCONNECTED`     | Check connectivity and rediscover the same browser/profile/tab | Only eligible safe reads, honoring response backoff; never replay uncertain mutations |
| `TIMEOUT`                    | Inspect progress and current state for actions; narrow slow reads | At most one eligible safe-read retry when recovery permits |
| `INTERNAL_ERROR`             | Inspect the specific recovery and execution evidence           | Safe reads only when recovery permits; local MCP uncertainty is non-retryable |
| `CONNECTION_LOST`            | Restore connectivity; a lost reply does not prove no execution | Only a known-safe read may be retried; inspect mutations instead |
| `BRIDGE_TIMEOUT`             | Narrow eligible reads; inspect postconditions for mutations    | No automatic replay of input, navigation, or sequences |

Timeout on a read-only content-script request → when recovery permits, retry once with a narrower `dom.query` or equivalent read. Do not repeat input through CDP as a timeout fallback.
Timeout on navigation → inspect `page.get_state` or use a read-only `page.wait_for_load_state` for the expected URL. Do not repeat navigate/reload/back/forward to recover a missing acknowledgment.
Timeout on `dom.wait_for` → returns `{found: false}` (not an error); check selector/state logic.

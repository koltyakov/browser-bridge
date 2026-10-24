# Token Efficiency

## Budget Presets

| Preset | maxNodes | maxDepth | textBudget | Use When                                 |
| ------ | -------- | -------- | ---------- | ---------------------------------------- |
| quick  | 5        | 2        | 300        | Checking one element or confirming state |
| normal | 25       | 4        | 600        | General inspection (default)             |
| deep   | 100      | 8        | 2000       | Complex nested components                |

Always start at **quick** or **normal**; widen only if the result indicates truncation.

These presets are also available at runtime via `bbx skill`.

## Debugger Policy

Avoid debugger-backed methods until they are clearly necessary. In Browser Bridge, `page.evaluate`, `page.handle_dialog`, `dom.get_accessibility_tree`, CDP network capture, CDP input execution, `viewport.resize`, `performance.get_metrics`, `screenshot.capture_*`, and `cdp.*` attach `chrome.debugger`, which can make Chrome show its native debugging banner across the running browser instance. `network.export_har` does not attach by itself, but it requires the explicit CDP capture to remain armed.

## Decision Tree

1. **Know the selector?** → `dom.query` with quick budget
2. **Know the visible text?** → `dom.find_by_text` (cheaper than query + scan)
3. **Know the ARIA role?** → `dom.find_by_role` (semantic, no selector guessing)
4. **Need one element's details?** → `dom.describe` with elementRef
5. **Need layout metrics?** → `layout.get_box_model` (no budget needed)
6. **Need styles?** → `styles.get_computed` with explicit `properties` list
7. **Need runtime errors?** → `page.get_console` with `level: 'error'`
8. **Need article or documentation content?** → `page.extract_content` (removes navigation and repeated chrome)
9. **Need all visible page UI text?** → `page.get_text` (cheaper than `dom.query` on body)
10. **Need API call history?** → default `page.get_network` (intercepted fetch/XHR log)
11. **Need portable all-resource evidence?** → explicitly arm CDP, reproduce, `network.export_har`, then stop capture
12. **Need framework/app state and no lighter read can expose it?** → `page.evaluate` (debugger-backed)
13. **Need an actionable page overview?** → `dom.get_accessibility_tree` with `source: "dom"` and `interactiveOnly: true`; reserve the debugger-backed CDP source for accessibility audits
14. **Need a raw Chrome/CDP counter point sample?** → `performance.get_metrics` (debugger-backed; no BBX navigation window or LCP/CLS/INP measurement)
15. **Testing responsive with an exact forced viewport?** → `viewport.resize` (debugger-backed)
16. **Visual ambiguity after structured reads?** → `screenshot.capture_element` first, or `screenshot.capture_region` with a tight crop when one element is not enough (debugger-backed)
17. **Content-script blocked?** → `cdp.get_document` or `cdp.get_dom_snapshot` (debugger-backed fallback)

### Optional visual deltas

Use `screenshot.baseline.create/compare/release` only for visual questions that semantic DOM diffs cannot answer, such as CSS regressions or canvas/chart updates. Create before the action with one complete component `selector` or viewport CSS `rect`. Compare afterward; no images are sent for exact equality. Changes retain real pixels and expand a single union crop into bounded semantic component boxes in both frames, with surrounding padding. Broad changes return full scoped evidence. This heuristic cannot guarantee readable labels; request a complete screenshot when context is missing.

Decide whether visual verification is needed before the action. If no reference was captured, inspect the current view instead of replaying an action just to manufacture before evidence. For removal checks, scope to a stable parent rather than the element that will disappear.

Keep `includeBefore: true` for disappearance or uncertain prior context. `includeBefore: false` saves an image only when the previous visual state is already known. `advance: true` explicitly makes a comparable frame the next reference without extending retention. Navigation invalidates the handle; scroll/viewport/geometry changes return one current scoped image, `equal: null`, and `requiresNewBaseline: true`, not a misleading pixel diff.

Crops can reduce dimension-based image-token costs. Full-size masks do not; PNG bytes and changed-pixel percentages are not token counts. A before/after pair may cost more than one new screenshot, especially on broad changes. Never claim action success or readiness from unchanged pixels. Baselines retain sensitive pixels in bounded native memory for at most five minutes; release promptly. Normal screenshots and DOM reads never create them.

## Allowlist Strategy

Always set allowlists when you know what you need:

```json
{
  "selector": ".card",
  "maxNodes": 10,
  "attributeAllowlist": ["class", "id", "href", "data-testid"],
  "textBudget": 400
}
```

Omitting allowlists or leaving the text budget wide open often returns 3–5× the tokens needed.

## Anti-Patterns (Token Waste)

| Pattern                                  | Cost                | Fix                                                                                          |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `dom.query` on `body` with no budget     | ~2000 tok           | Use specific selector + quick budget                                                         |
| Screenshot before structured read        | ~1500 tok wasted    | Always `dom.query` or `styles.get_computed` first                                            |
| Re-querying DOM for same element         | ~500 tok/call       | Reuse `elementRef` from prior result                                                         |
| Full-page screenshot                     | ~3000 tok           | Use `screenshot.capture_element`, or `screenshot.capture_region` with a tight rect           |
| Requesting broad computed styles via CDP | ~800 tok            | Use `styles.get_computed`; omission returns five core props, or pass 3-8 explicit props      |
| Multiple CLI calls for independent reads | overhead/call       | Use `batch` command                                                                          |
| Guessing selectors for known labels      | ~300 tok wasted/try | Put a locator in the input target (`{"role":"button","name":"Save"}`, `{"label":"Email"}`)  |
| Find, then act, then re-read             | 3 round trips       | One locator-targeted action; read its `effects` instead of re-querying                       |
| `dom.wait_for` before every action       | 1 extra round trip  | Actions auto-wait (`timeoutMs`, default 2500)                                                |
| Polling page state with repeated queries | ~500 tok/poll       | Use `dom.wait_for` (single call, waits async)                                                |
| Inspecting DOM to read app state         | ~800 tok            | Use `page.evaluate` to read JS directly                                                      |
| Re-querying after HMR without waiting    | ~500 tok stale      | `dom.wait_for` first, then query                                                             |
| Separate call to verify a patch          | ~500 tok wasted     | Set `verify: true` on `patch.apply_styles` / `patch.apply_dom` to get computed result inline |
| `dom.query` on body for page text        | ~2000 tok           | Use `page.get_text` (extracts innerText directly)                                            |
| Guessing interactive elements from DOM   | ~600 tok/try        | `dom.get_accessibility_tree` with `source: "dom"`: ~10 tokens per control, refs included     |
| Fetching network via evaluate hacks      | ~400 tok            | Use `page.get_network` (auto-interceptor)                                                    |
| Full a11y tree with no limits            | ~3000 tok           | Set `maxNodes` ≤ 50, `maxDepth` ≤ 4                                                          |
| CDP network capture for API-only traffic | debugger lifecycle  | Use default fetch/XHR capture; reserve CDP for all-resource failures                         |
| Broad inline HAR export                  | token/byte pressure | Narrow `urlPattern`/`limit`, or use `delivery: "artifact"`; bounds remove whole entries      |
| Repeated page-state polling for a route  | ~500 tok/poll       | Use one event-aware `page.wait_for_load_state` URL condition                                 |

## Efficient Loop

1. Query narrow subtree (quick budget).
2. Pick one `elementRef`.
3. Read only needed styles/layout.
4. Patch narrowly.
5. Check `page.get_console` if the behavior might be error-driven.
6. Verify with `layout.get_box_model` or `styles.get_computed`.
7. Escalate to debugger-backed methods only if the answer is still missing.
8. Screenshot only if structured evidence is ambiguous, and keep the capture partial.

## Evaluate Instead of DOM Scan

When you need app state (router, store, config), `page.evaluate` can be far cheaper than parsing DOM, but it is debugger-backed. Use it only after DOM, text, storage, console, and network reads still leave uncertainty:

```bash
# Read Next.js route - 1 call vs. parsing URL from dom.query on <head>
bbx eval 'window.__NEXT_DATA__?.page'

# Read React store state
bbx eval 'document.querySelector("[data-reactroot]")?.__reactFiber$?.memoizedState'

# Check feature flag
bbx eval 'window.__APP_CONFIG__?.features?.darkMode'
```

## Console for Error Detection

After interactions, check for runtime errors instead of guessing from DOM:

```bash
bbx console error    # just errors and exceptions
```

Install early - the buffer auto-activates on first call. Captured levels: log, warn, error, info, debug, exception, rejection.

## Page Text Instead of DOM Scan

When you need every visible UI label, use `page.get_text` instead of `dom.query` on `body`. For articles, documentation, or long issues, prefer `page.extract_content` so navigation and repeated chrome are removed first:

```bash
bbx page-text           # default 8000 char budget
bbx page-text 8000      # larger budget for long pages
bbx call page.extract_content '{"format":"markdown","textBudget":8000}'
```

This is 3–5× cheaper than querying the body's subtree with `dom.query`.

## Network Monitoring

Check API calls without manual `page.evaluate` fetch interception:

```bash
bbx network              # recent fetch/XHR entries
bbx network 50           # last 50 entries
```

The interceptor auto-installs on first call. Before reproducing an event, call `page.get_network` once with `clear: true` to install capture and remove old entries. Trigger the action, then read again without `clear`. Each entry shows `method`, `url`, `status`, `duration`.

Only escalate to `source: "cdp"` when fetch/XHR misses the relevant document, asset, socket, cache, redirect, or failed-resource metadata. CDP must be started before reproduction and explicitly stopped afterward; it holds debugger ownership, tracks in-flight state, and returns a larger entry shape. Its URLs redact credentials, fragments, and query values, and it never returns bodies, cookies, authorization values, or complete headers.

For a HAR, export while that capture is still armed, then stop it. Use a narrow
sanitized-URL `urlPattern` and small `limit` first. Inline delivery removes whole
oldest entries to meet byte/token bounds rather than truncating fields; inspect
`truncation`, `dropped`, `abandoned`, and `inflight`. Use `delivery: "artifact"`
for larger evidence. The five-minute opaque handle is owner-scoped and has no
browser-host path; `bbx har` downloads, verifies, deletes, and atomically writes
it on the CLI host through the same client.

## Accessibility Outline for Semantic Discovery

When you need the page's interactive structure without guessing selectors:

```bash
bbx call dom.get_accessibility_tree '{"source":"dom","interactiveOnly":true,"maxNodes":60}'
```

Each control is one line (`- button "Save" [el_k7q2_1f]`, about 10 tokens versus about 80 for a JSON AX node), refs act directly, and no debugger is attached. The CDP tree (`source` omitted) is for audits; add `format: "outline"` to keep it compact.

## Act, Then Read Effects

Input actions return what changed (`effects`: URL, dialogs, alerts/status text, focus, DOM churn, target state), and the summary digests it in one line. Routine successes omit resolution/execution metadata; it appears only when something notable happened (scroll, wait, ranking, stale recovery, CDP). Element refs are short (`el_k7q2_1f`). Re-read the page only when the effects leave the question open.

## Semantic finding Saves Selector Guessing

When you know the text label but not the selector, `find_by_text` and `find_by_role` skip the trial-and-error:

```bash
# Instead of guessing: dom.query '.btn-primary', '.submit-btn', 'button[type=submit]'...
bbx find 'Submit Order'   # finds it in one call

# Instead of dom.query 'nav', '.navigation', '#main-nav'...
bbx find-role navigation  # semantic, works regardless of classes
```

## HMR-Aware Waiting

After modifying source code, the dev server hot-reloads. Wait for evidence of the change, not `attached` on a selector that already exists:

```bash
bbx call dom.wait_for '{"selector":"[data-component=\"Header\"][data-version=\"new\"]","state":"attached","timeoutMs":5000}'
bbx call dom.wait_for '{"selector":"[data-component=\"Header\"]","text":"Expected new heading","timeoutMs":5000}'
# For a known remount, wait for detached and then attached states.
bbx console error                            # check for HMR errors
```

## Parent-Agent Response Policy

The subagent should return:

- What was inspected (selector or elementRef)
- What changed (if patching)
- Whether it answers the question

Store oversized outputs as local artifacts; return path + summary only.

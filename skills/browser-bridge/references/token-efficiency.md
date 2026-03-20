# Token Efficiency

## Budget Presets

| Preset | maxNodes | maxDepth | textBudget | Use When |
|--------|----------|----------|------------|----------|
| quick | 5 | 2 | 300 | Checking one element or confirming state |
| normal | 25 | 4 | 600 | General inspection (default) |
| deep | 100 | 8 | 2000 | Complex nested components |

Always start at **quick** or **normal**; widen only if the result indicates truncation.

These presets are also available at runtime via `node packages/agent-client/src/cli.js skill`.

## Decision Tree

1. **Know the selector?** → `dom.query` with quick budget
2. **Know the visible text?** → `dom.find_by_text` (cheaper than query + scan)
3. **Know the ARIA role?** → `dom.find_by_role` (semantic, no selector guessing)
4. **Need one element's details?** → `dom.describe` with elementRef
5. **Need layout metrics?** → `layout.get_box_model` (no budget needed)
6. **Need styles?** → `styles.get_computed` with explicit `properties` list
7. **Need framework/app state?** → `page.evaluate` (read JS directly, skip DOM guessing)
8. **Need runtime errors?** → `page.get_console` with `level: 'error'`
9. **Visual ambiguity?** → `screenshot.capture_element` with small crop
10. **Content-script blocked?** → `cdp.get_document` or `cdp.get_dom_snapshot`

## Allowlist Strategy

Always set allowlists when you know what you need:

```json
{
  "selector": ".card",
  "maxNodes": 10,
  "attributeAllowlist": ["class", "id", "href", "data-testid"],
  "styleAllowlist": ["display", "flex-direction", "gap", "padding", "margin"]
}
```

Omitting allowlists returns all attributes/styles — often 3–5× the tokens needed.

## Anti-Patterns (Token Waste)

| Pattern | Cost | Fix |
|---------|------|-----|
| `dom.query` on `body` with no budget | ~2000 tok | Use specific selector + quick budget |
| Screenshot before structured read | ~1500 tok wasted | Always `dom.query` or `styles.get_computed` first |
| Re-querying DOM for same element | ~500 tok/call | Reuse `elementRef` from prior result |
| Full-page screenshot | ~3000 tok | Use `screenshot.capture_element` with small rect |
| Requesting all computed styles | ~800 tok | Set `properties` list (usually 3–8 props) |
| Multiple CLI calls for independent reads | overhead/call | Use `batch` command |
| Guessing selectors for known labels | ~300 tok wasted/try | Use `dom.find_by_text` or `dom.find_by_role` |
| Polling page state with repeated queries | ~500 tok/poll | Use `dom.wait_for` (single call, waits async) |
| Inspecting DOM to read app state | ~800 tok | Use `page.evaluate` to read JS directly |
| Re-querying after HMR without waiting | ~500 tok stale | `dom.wait_for` first, then query |

## Efficient Loop

1. Query narrow subtree (quick budget).
2. Pick one `elementRef`.
3. Read only needed styles/layout.
4. Patch narrowly.
5. Verify with `layout.get_box_model` or `styles.get_computed`.
6. Screenshot only if structured evidence is ambiguous.

## Evaluate Instead of DOM Scan

When you need app state (router, store, config), `page.evaluate` is far cheaper than parsing DOM:

```bash
# Read Next.js route — 1 call vs. parsing URL from dom.query on <head>
npx bb eval 'window.__NEXT_DATA__?.page'

# Read React store state
npx bb eval 'document.querySelector("[data-reactroot]")?.__reactFiber$?.memoizedState'

# Check feature flag
npx bb eval 'window.__APP_CONFIG__?.features?.darkMode'
```

## Console for Error Detection

After interactions, check for runtime errors instead of guessing from DOM:

```bash
npx bb console error    # just errors and exceptions
```

Install early — the buffer auto-activates on first call. Captured levels: log, warn, error, info, debug, exception, rejection.

## Semantic Finding Saves Selector Guessing

When you know the text label but not the selector, `find_by_text` and `find_by_role` skip the trial-and-error:

```bash
# Instead of guessing: dom.query '.btn-primary', '.submit-btn', 'button[type=submit]'...
npx bb find 'Submit Order'   # finds it in one call

# Instead of dom.query 'nav', '.navigation', '#main-nav'...
npx bb find-role navigation  # semantic, works regardless of classes
```

## HMR-Aware Waiting

After modifying source code, the dev server hot-reloads. Always wait before inspecting:

```bash
npx bb wait '[data-component="Header"]' 5000   # wait for component re-mount
npx bb console error                            # check for HMR errors
npx bb eval 'module.hot?.status?.()'            # check HMR status (webpack)
```

## Parent-Agent Response Policy

The subagent should return:
- What was inspected (selector or elementRef)
- What changed (if patching)
- Whether it answers the question

Store oversized outputs as local artifacts; return path + summary only.

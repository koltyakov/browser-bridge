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
2. **Need one element's details?** → `dom.describe` with elementRef
3. **Need layout metrics?** → `layout.get_box_model` (no budget needed)
4. **Need styles?** → `styles.get_computed` with explicit `properties` list
5. **Visual ambiguity?** → `screenshot.capture_element` with small crop
6. **Content-script blocked?** → `cdp.get_document` or `cdp.get_dom_snapshot`

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

## Efficient Loop

1. Query narrow subtree (quick budget).
2. Pick one `elementRef`.
3. Read only needed styles/layout.
4. Patch narrowly.
5. Verify with `layout.get_box_model` or `styles.get_computed`.
6. Screenshot only if structured evidence is ambiguous.

## Parent-Agent Response Policy

The subagent should return:
- What was inspected (selector or elementRef)
- What changed (if patching)
- Whether it answers the question

Store oversized outputs as local artifacts; return path + summary only.

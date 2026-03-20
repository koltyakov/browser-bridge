# Token Efficiency

## Default posture

Prefer:
- small structured DOM summaries
- targeted style reads
- element handles for follow-ups
- cropped screenshots only when needed

Avoid:
- full-page screenshots
- raw HTML dumps
- large text blobs
- repeated broad DOM scans

## Budgeting guidance

- Start with `maxNodes <= 20`.
- Keep `maxDepth <= 4` unless a component is deeply nested.
- Keep `textBudget <= 800` for most inspection tasks.
- Always set `attributeAllowlist` and `styleAllowlist` when you know the fields you need.
- Ask for one component, form section, or container at a time.

## Efficient loop

1. Query a narrow subtree.
2. Choose one `elementRef`.
3. Read only the necessary styles or layout metrics.
4. Patch narrowly.
5. Re-verify with layout or style reads.
6. Screenshot only if structured evidence is ambiguous.

## Parent-agent response policy

The browser subagent should summarize:
- what it inspected
- what changed
- whether the result answers the question

Store oversized outputs as local artifacts and return only the path plus a short summary.

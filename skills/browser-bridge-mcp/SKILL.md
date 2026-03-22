---
name: browser-bridge-mcp
description: "Browser Bridge MCP mode - token-efficient Chrome tab inspection and patching via MCP tools. Use when Browser Bridge is connected through an MCP server instead of the bbx CLI."
---

# Browser Bridge MCP

Browser Bridge MCP is the MCP-first companion to the CLI-oriented `browser-bridge` skill.

Use this skill when the client exposes Browser Bridge as MCP tools. Do not shell out to `bbx` commands when the MCP tools are already available.

This mode is usually better inside MCP-native clients because tool schemas, discovery, and invocation stay inside the client's MCP flow. The CLI-oriented skill is usually better for terminal-driven debugging, manual reproduction, install/doctor flows, or any environment where MCP is unavailable or awkward to configure.

Prompt name: `$browser-bridge-mcp`. Prompt shorthand: `$bbx-mcp` where aliases are supported.
Example prompt: `Using bbx-mcp verify the current page layout matches the design and keep reads token-efficient`.

## Core Flow

1. Call `browser_status` first. Stop on daemon, extension, or session readiness failures.
2. Ensure access with `browser_session`.
3. Call `browser_skill` once near the start of the task to get live budgets, method groups, limits, and capability hints. (This replaces the old `browser_call(method="skill.get_runtime_context")` pattern.)
4. Prefer grouped MCP tools over raw calls:
   - `browser_dom`
   - `browser_styles_layout`
   - `browser_page`
   - `browser_navigation`
   - `browser_input`
   - `browser_patch`
   - `browser_capture`
5. Use `browser_call` only when the grouped tools do not expose the required Browser Bridge method cleanly.

## Token Efficiency Rules

1. Structured first: DOM, styles, layout, page state before screenshots or CDP snapshots.
2. Start with tight budgets: `maxNodes<=20`, `maxDepth<=4`, `textBudget<=800`.
3. Reuse `elementRef` values. Do not rescan large subtrees unless the element went stale.
4. Always constrain output with `attributeAllowlist`, `styleAllowlist`, `properties`, `keys`, `limit`, or `maxResults` when available.
5. Use `browser_capture` only when structured reads are ambiguous.
6. Prefer a single targeted read over broad `html` or full-page text extraction.
7. Request only the session capabilities needed for the task. If a call fails with `CAPABILITY_MISSING`, re-request access with the missing capability instead of over-broadening by default.
8. Batch mentally, not noisily: avoid exploratory chains of near-duplicate MCP calls.

## Discovery And Capability Use

- MCP tool discovery comes from the MCP server's registered tools and schemas.
- Runtime Browser Bridge discovery comes from `browser_call(method="skill.get_runtime_context")`.
- Current session scope comes from `browser_session` with `action: "get_status"`.
- Capability failures are informative. Treat `CAPABILITY_MISSING` as a prompt to request the smallest additional capability bundle.

## Recommended Tool Patterns

- Inspect: `browser_dom` with `query`, then `browser_styles_layout` with `computed` or `box_model`.
- Find semantic targets: `browser_dom` with `find_text`, `find_role`, or `accessibility_tree`.
- Read framework/app state: `browser_page` with `evaluate`.
- Verify interactions: perform `browser_input`, then check `browser_page` console/network or `browser_dom` wait conditions.
- Prototype fixes: `browser_patch` with `apply_styles` before `apply_dom`.
- Responsive checks: `browser_navigation` with `resize`, then re-read the affected area with narrow budgets.

## Error Recovery

| Error | Recovery |
|---|---|
| `APPROVAL_PENDING` / `ACCESS_DENIED` | Retry after user enables the tab in the extension UI |
| `SESSION_EXPIRED` | Request access again |
| `ELEMENT_STALE` | Re-run the smallest possible finder/query to get a fresh `elementRef` |
| `ORIGIN_MISMATCH` | The tab navigated; request access for the new origin |
| `CAPABILITY_MISSING` | Re-request access with only the missing capability |
| `TIMEOUT` / `BRIDGE_TIMEOUT` | Retry once with narrower scope and lower output volume |

## Escalation

- Prefer `browser_capture` `element`/`region` over raw CDP captures.
- Use the `cdp_*` capture actions only when structured DOM/style/layout data is insufficient.
- Avoid screenshots for routine verification when computed styles, box models, and semantic DOM evidence are enough.

## Output

Return concise findings with the tab/origin, key evidence, and any temporary patches that must be rolled back.

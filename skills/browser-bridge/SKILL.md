---
name: bb
description: "Browser Bridge — Token-efficient Chrome tab inspection and patching via local bridge extension. Use instead of Playwright or screenshot-heavy automation when a Chrome tab has agent communication enabled."
---

# Browser Bridge

Scoped Chrome tab inspection, interaction, and CSS/DOM patching through a local native-messaging bridge. Use a subagent for bridge calls; return only concise findings to the parent.

## CLI

```bash
npx bb status                  # check bridge connection
npx bb request-access          # get session for active tab
npx bb call <method> '{...}'   # any RPC method
npx bb batch '[{...},...]'     # parallel reads
npx bb skill                   # live runtime presets
```

## Access Retry Flow

`request-access` may return `APPROVAL_PENDING` because the user must enable the tab in the extension UI first.

1. Call `request-access`. If success, proceed.
2. On `APPROVAL_PENDING` / `ACCESS_DENIED`, wait ~3s, retry up to 4 more times.
3. If all fail, ask the user to enable the tab and type **ready**, then retry once.

## Core Rules

1. **Structured first** — `dom.query` → `styles.get_computed` → `layout.get_box_model` before screenshots.
2. **Budget tight** — `maxNodes≤20`, `maxDepth≤4`, `textBudget≤800`. Always set allowlists.
3. **Reuse refs** — use returned `elementRef` for follow-ups; don't rescan.
4. **Style before DOM** — `patch.apply_styles` before `patch.apply_dom`.
5. **Rollback** — revert every patch before finishing unless user wants mutations kept.
6. **Confirm scope** — `status` first; stop if no extension connection.
7. **Screenshots last** — only when structured evidence is ambiguous; keep crops small.
8. **Batch reads** — combine independent reads in one `batch` call.
9. **Evaluate for state** — use `page.evaluate` to read framework state (React, Vue, Next.js `__NEXT_DATA__`, router, stores) instead of guessing from DOM.
10. **Wait after change** — after editing source files or triggering navigation, use `dom.wait_for` or `page.wait_for_load_state` before inspecting.
11. **Console after interaction** — call `page.get_console` after mutations to catch runtime errors early.
12. **Semantic finding** — use `dom.find_by_text` / `dom.find_by_role` when you know the label but not the selector.

## Method Quick Reference

| Category   | Key Methods                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| Session    | `session.request_access`, `session.get_status`, `page.get_state`                         |
| Inspect    | `dom.query`, `dom.describe`, `dom.get_html`, `styles.get_computed`, `layout.get_box_model`|
| Find       | `dom.find_by_text`, `dom.find_by_role`, `dom.wait_for`                                   |
| Page State | `page.evaluate`, `page.get_console`, `page.get_storage`, `page.wait_for_load_state`      |
| Interact   | `input.click`, `input.type`, `input.focus`, `input.press_key`, `input.hover`, `input.drag`|
| Patch      | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`                                |
| Navigate   | `navigation.navigate`, `viewport.scroll`                                                 |
| Escalate   | `screenshot.capture_element`, `cdp.*` methods                                            |

## Dev-Server Workflow (HMR-aware)

When the user has a localhost dev server with watch/HMR:

1. **Inspect current state** — `page.get_state` + quick `dom.query` on the relevant area.
2. **Read framework state** — `page.evaluate` to check router, component props, store values.
3. **Identify the problem** — use `styles.get_computed`, `dom.get_html`, or `page.get_console` for errors.
4. **Prototype with patches** — `patch.apply_styles` / `patch.apply_dom` to verify the fix visually.
5. **Edit source files** — modify the actual code in the agent's workspace.
6. **Wait for HMR** — `dom.wait_for` with the selector that should change, or `page.wait_for_load_state`.
7. **Verify the change** — re-inspect the same area; compare with patch expectations.
8. **Check for regressions** — `page.get_console` for new errors; scroll and inspect adjacent areas.
9. **Rollback patches** — `patch.rollback` all temporary patches.

## Investigate-a-Bug Workflow

```
page.get_state → page.get_console (check for errors)
  → dom.find_by_text('<error text>') or dom.query('<selector>')
  → styles.get_computed (check layout/visibility)
  → page.evaluate('document.querySelector(...).dataset') (read data attrs)
  → page.evaluate('window.__APP_STATE__') (read framework state)
  → patch.apply_styles (test fix) → verify → edit source → wait for HMR → verify
```

## User-Flow Testing Workflow

```
dom.find_by_role('button', 'Login') → input.click
  → dom.wait_for('.dashboard', {state: 'visible', timeoutMs: 10000})
  → page.get_state (verify URL changed)
  → page.get_console (check for errors)
  → dom.query('.dashboard', {maxNodes: 15}) (inspect result)
```

## Detailed References (load only when needed)

- **[Inspection & token efficiency](references/token-efficiency.md)** — budget presets, decision tree, allowlist strategy, anti-patterns
- **[Patching workflows](references/patch-workflow.md)** — style-first loop, DOM patches, verification, cleanup
- **[Full protocol reference](references/protocol.md)** — all RPC methods, error codes
- **[Interaction patterns](references/interaction.md)** — input methods, navigation, form controls, hover, drag

## Subagent Output

Return: verdict, tab id + origin, minimal evidence set. No raw HTML or base64 images.

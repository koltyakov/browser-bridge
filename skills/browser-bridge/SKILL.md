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

## Method Quick Reference

| Category | Key Methods                                                                |
| -------- | -------------------------------------------------------------------------- |
| Session  | `session.request_access`, `session.get_status`, `page.get_state`           |
| Inspect  | `dom.query`, `dom.describe`, `styles.get_computed`, `layout.get_box_model` |
| Interact | `input.click`, `input.type`, `input.focus`, `input.press_key`              |
| Patch    | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`                  |
| Navigate | `navigation.navigate`, `viewport.scroll`                                   |
| Escalate | `screenshot.capture_element`, `cdp.*` methods                              |

## Detailed References (load only when needed)

- **[Inspection & token efficiency](references/token-efficiency.md)** — budget presets, decision tree, allowlist strategy, anti-patterns
- **[Patching workflows](references/patch-workflow.md)** — style-first loop, DOM patches, verification, cleanup
- **[Full protocol reference](references/protocol.md)** — all RPC methods, request envelope, failure codes
- **[Interaction patterns](references/interaction.md)** — input methods, navigation, viewport, form controls

## Subagent Output

Return: verdict, tab id + origin, minimal evidence set. No raw HTML or base64 images.

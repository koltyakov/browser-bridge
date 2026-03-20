---
name: browser-bridge
description: Token-efficient Chrome tab inspection and patching via local bridge extension. Use instead of Playwright or screenshot-heavy automation when a Chrome tab has agent communication enabled.
---

# Browser Bridge

Scoped Chrome tab inspection, interaction, and CSS/DOM patching through a local native-messaging bridge. Use a subagent for bridge calls; return only concise findings to the parent.

## Quick Start

```bash
node packages/agent-client/src/cli.js status
node packages/agent-client/src/cli.js request-access
node packages/agent-client/src/cli.js call dom.query '{"selector":"main","maxNodes":8,"maxDepth":2}'
```

Run `node packages/agent-client/src/cli.js skill` for live runtime guidance including budget presets and method groups.

## Access Retry Flow

`request-access` may return `APPROVAL_PENDING` or `ACCESS_DENIED` because the user must first enable the tab in the extension popup or side panel. Handle this as follows:

1. Call `request-access`. If it succeeds, proceed.
2. If it returns `APPROVAL_PENDING` or `ACCESS_DENIED`, **wait ~3 seconds** and retry.
3. Retry up to **4 more times** (5 attempts total), waiting ~3 s between each.
4. If all retries fail, **tell the user**:
   > Please enable agent communication for the active tab in the Browser Bridge extension (popup or side panel), then type **ready** so I can continue.
5. When the user replies "ready", call `request-access` once more and proceed normally.

## Core Rules

1. **Structured first** — `dom.query` → `styles.get_computed` → `layout.get_box_model` before any screenshot.
2. **Budget tight** — `maxNodes≤20`, `maxDepth≤4`, `textBudget≤800`. Always set `attributeAllowlist`/`styleAllowlist`.
3. **Reuse refs** — use returned `elementRef` values for follow-ups; don't rescan.
4. **Style before DOM** — try `patch.apply_styles` before `patch.apply_dom`.
5. **Rollback** — revert every patch before finishing unless user wants mutations kept.
6. **Confirm scope** — call `status` first; stop if no extension connection.
7. **Screenshots last** — only when structured evidence is ambiguous; keep crops small.
8. **Batch when possible** — combine independent reads in one `batch` call to reduce round-trips.

## Method Quick Reference

| Category | Key Methods |
|----------|-------------|
| Session | `session.request_access`, `session.get_status`, `page.get_state` |
| Inspect | `dom.query`, `dom.describe`, `styles.get_computed`, `layout.get_box_model` |
| Interact | `input.click`, `input.type`, `input.focus`, `input.press_key` |
| Patch | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback` |
| Navigate | `navigation.navigate`, `viewport.scroll` |
| Escalate | `screenshot.capture_element`, `cdp.*` methods |

Use `call <method> '{...}'` for any method. See [references/protocol.md](references/protocol.md) for the full RPC surface.

## Workflow Pointers

- **Inspection flow**: [references/token-efficiency.md](references/token-efficiency.md)
- **Patching flow**: [references/patch-workflow.md](references/patch-workflow.md)
- **Full method list**: [references/protocol.md](references/protocol.md)

## Subagent Output

Return: verdict, tab id + origin, minimal evidence set. No raw HTML or base64 images.

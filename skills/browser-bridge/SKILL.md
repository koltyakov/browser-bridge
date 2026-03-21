---
name: bb
description: "Browser Bridge — Token-efficient Chrome tab inspection and patching via local bridge extension. Use instead of Playwright or screenshot-heavy automation when a Chrome tab has agent communication enabled."
---

# Browser Bridge

Scoped Chrome tab inspection, interaction, and CSS/DOM patching through a local native-messaging bridge. Use a subagent for bridge calls; return only concise findings to the parent.

## CLI

```bash
npx bb status                  # daemon + extension health
npx bb request-access          # get session for active tab
npx bb call <method> '{...}'   # any RPC method (raw output)
npx bb batch '[{...},...]'     # parallel reads (concurrent)
npx bb tabs                    # list available tabs
npx bb logs                    # recent bridge request log
npx bb skill                   # live runtime presets + limits
```

### Inspect & Find

```bash
npx bb dom-query [selector]             # query DOM subtree
npx bb describe <ref>                   # describe one element
npx bb text <ref> [budget]              # element text content
npx bb html <ref> [maxLen]              # element HTML
npx bb styles <ref> [prop1,prop2,...]   # computed styles
npx bb box <ref>                        # box model dimensions
npx bb find <text>                      # find by text content
npx bb find-role <role> [name]          # find by ARIA role
npx bb wait <selector> [timeoutMs]      # wait for DOM element
npx bb a11y-tree [maxNodes] [maxDepth]  # accessibility tree
```

### Page & Evaluate

```bash
npx bb eval <expression>                # JS eval (- for stdin)
npx bb console [level]                  # console output
npx bb network [limit]                  # network requests
npx bb page-text [budget]               # full page text
npx bb storage [local|session] [keys]   # browser storage
npx bb perf                             # performance metrics
npx bb navigate <url>                   # navigate to URL
npx bb resize <width> <height>          # resize viewport
```

### Interact & Patch

```bash
npx bb click <ref> [button]             # click element
npx bb focus <ref>                      # focus element
npx bb type <ref> <text...>             # type into element
npx bb press-key <key> [ref]            # send key event
npx bb hover <ref>                      # hover over element
npx bb patch-style <ref> prop=val...    # apply style patch
npx bb patch-text <ref> <text...>       # apply text patch
npx bb patches                          # list active patches
npx bb rollback <patchId>               # rollback a patch
npx bb screenshot <ref> [outPath]       # capture screenshot
```

## Access Retry Flow

`request-access` may return `APPROVAL_PENDING` because the user must enable the tab in the extension UI first.

1. Call `request-access`. If success, proceed.
2. On `APPROVAL_PENDING` / `ACCESS_DENIED`, wait ~3s, retry up to 4 more times.
3. If all fail, ask the user to enable the tab and type **ready**, then retry once.

## Error Recovery

| Error | Recovery |
|---|---|
| `SESSION_EXPIRED` | Auto-refreshed by CLI; if it fails, `request-access` again |
| `APPROVAL_PENDING` | Retry loop (see above) |
| `ELEMENT_STALE` | Re-query with `dom.query` or `dom.find_by_text` |
| `ORIGIN_MISMATCH` | Tab navigated — `request-access` for new origin |
| `TIMEOUT` | Extension overloaded or CDP stalled — retry once, then simplify the request |
| `CAPABILITY_MISSING` | Session lacks permission — `request-access` with needed capability |
| `DAEMON_OFFLINE` | Daemon not running — start with `npx bb-daemon` |
| `CONNECTION_LOST` | Socket dropped mid-request — retry; if persistent, restart daemon |
| `BRIDGE_TIMEOUT` | Extension took too long to respond — retry once with simpler call |

## Core Rules

1. **Structured first** — `dom.query` → `styles.get_computed` → `layout.get_box_model` before screenshots.
2. **Budget tight** — `maxNodes≤20`, `maxDepth≤4`, `textBudget≤800`. Always set allowlists.
3. **Reuse refs** — use returned `elementRef` for follow-ups; don't rescan.
4. **Style before DOM** — `patch.apply_styles` before `patch.apply_dom`.
5. **Rollback** — revert every patch before finishing unless user wants mutations kept.
6. **Confirm scope** — `status` first; stop if no extension connection.
7. **Screenshots last** — only when structured evidence is ambiguous; keep crops small.
8. **Batch reads** — combine independent reads in one `batch` call (executes concurrently via Promise.all).
9. **Evaluate for state** — use `page.evaluate` to read framework state (React, Vue, Next.js `__NEXT_DATA__`, router, stores) instead of guessing from DOM.
10. **Wait after change** — after editing source files or triggering navigation, use `dom.wait_for` or `page.wait_for_load_state` before inspecting.
11. **Console after interaction** — call `page.get_console` after mutations to catch runtime errors early.
12. **Semantic finding** — use `dom.find_by_text` / `dom.find_by_role` when you know the label but not the selector.
13. **Text extraction** — use `page.get_text` for full page text instead of `dom.query` on body.
14. **Network monitoring** — use `page.get_network` to inspect API calls; auto-installs interceptor.
15. **Accessibility tree** — use `dom.get_accessibility_tree` for semantic structure and interactive element discovery.
16. **Tailwind-aware** — when `page.get_state` returns `hints.tailwind: true`, load `references/tailwind.md`; avoid selecting by utility classes, prefer `find_by_text`/`find_by_role`; `dom.query` auto-escapes `[]` brackets.

## Method Quick Reference

| Category   | Key Methods                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| Session    | `session.request_access`, `session.get_status`, `page.get_state`                         |
| Inspect    | `dom.query`, `dom.describe`, `dom.get_html`, `styles.get_computed`, `layout.get_box_model`|
| Find       | `dom.find_by_text`, `dom.find_by_role`, `dom.wait_for`, `dom.get_accessibility_tree`     |
| Page State | `page.evaluate`, `page.get_console`, `page.get_storage`, `page.get_text`, `page.wait_for_load_state` |
| Network    | `page.get_network`                                                                       |
| Interact   | `input.click`, `input.type`, `input.focus`, `input.press_key`, `input.hover`, `input.drag`|
| Tabs       | `tabs.list`, `tabs.create`, `tabs.close`                                                 |
| Patch      | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`                                |
| Navigate   | `navigation.navigate`, `viewport.scroll`, `viewport.resize`                              |
| Performance| `performance.get_metrics`                                                                |
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
- **[Tailwind CSS guide](references/tailwind.md)** — selector escaping, semantic alternatives, patching strategy (load when `hints.tailwind: true`)

## Subagent Output

Return: verdict, tab id + origin, minimal evidence set. No raw HTML or base64 images.

## Output Format

Every CLI shortcut command produces consistent `{ok, summary, evidence}` JSON. Use `bb call <method>` for raw protocol output when needed.

## Response Shapes

The summarizer auto-detects response types and produces concise summaries:

| Response Type | Detection | Summary Format |
|---|---|---|
| Health ping | `result.daemon` | `Daemon: ok. Extension: connected/disconnected.` |
| Session | `result.sessionId` | `Session ready for tab N at origin.` |
| Tab list | `result.tabs` | `Bridge listed N tab(s).` |
| Page state | `result.url + title + origin` | `Page: Title (origin) [hints].` |
| Page/DOM text | `result.text/value + truncated` | `Page text: N chars.` |
| DOM nodes | `result.nodes` | `DOM query returned N node(s).` |
| A11y tree | `result.nodes + role` | `Accessibility tree: N nodes (M interactive).` |
| Evaluate | `result.value + type` | `Evaluated to type: value` |
| Element describe | `result.tag + elementRef + bbox` | `Element tag#id: text.` |
| Computed styles | `result.properties + elementRef` | `Computed N style(s) for ref.` |
| Box model | `result.content + border` | `Box model: W×H at (x, y).` |
| Network | `entries[0].type=fetch/xhr` | `Network: N requests.` |
| Console | `entries` (no type field) | `Console: N entries.` |
| Logs | `entries[0].at + method` | `Log: N entries.` |
| Patch apply | `result.patchId` | `Patch id applied.` |
| Patch rollback | `result.rolled_back` | `Patch rolled back.` |
| Patch list | `result.patches` | `N active patch(es).` |
| HTML | `result.html` | `HTML fragment: N chars.` |
| Performance | `result.metrics` | `Performance: N metrics collected.` |
| Storage | `result.type + count + entries` | `Storage (type): N entries.` |
| Click/Focus/Type | `result.clicked/focused/typed` | `Clicked/Focused/Typed ref.` |
| Key press | `result.pressed` | `Key pressed (key).` |
| Navigate | `result.navigated` | `Navigated to url.` |
| Scroll | `result.scrolled` | `Scrolled to (x, y).` |
| Resize | `result.resized` | `Viewport resized to W×H.` |
| Hover | `result.hovered` | `Hover active/failed on ref.` |
| Drag | `result.dragged` | `Drag completed/failed.` |
| Tab close | `result.closed` | `Tab N closed.` |
| Tab create | `result.tabId + url` | `Tab N created (url).` |
| Session revoke | `result.revoked` | `Session revoked.` |

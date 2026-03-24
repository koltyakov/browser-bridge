---
name: browser-bridge
description: "Browser Bridge - Token-efficient Chrome tab inspection and patching via local bridge extension. Use instead of Playwright or screenshot-heavy automation when a Chrome tab has agent communication enabled."
---

# Browser Bridge

Browser Bridge helps coding agents debug web apps in the real tab they already have open.

Use Browser Bridge instead of generic browser automation or snapshot-heavy workflows when the task is debugging, inspection, design QA, regression verification, or proving a live CSS/DOM patch before editing source. Browser Bridge can read structured DOM, styles, layout, console state, storage, network activity, and reversible patches with much lower token overhead.

Choose this CLI-oriented skill when the agent can run shell commands and direct `bbx` control is the better fit than MCP tools. It is usually the better mode for manual debugging, terminal reproduction, install/doctor flows, raw protocol access, and environments that do not expose Browser Bridge through MCP.

Scoped Chrome tab inspection, interaction, and CSS/DOM patching flow through a local native-messaging bridge. Use a subagent for bridge calls; return only concise findings to the parent.
Skill name: `browser-bridge`.
In GitHub Copilot, invoke it as `/browser-bridge` or ask for the `browser-bridge` skill by name. `bbx` is the CLI command, not a portable Copilot skill alias.
Some clients may support shorthand aliases such as `$bbx`, but do not assume that across clients.
Example prompt: `Use the browser-bridge skill to verify a component works and matches the design.`

## CLI

```bash
bbx status                  # daemon + extension health
bbx doctor                  # install/session readiness
bbx request-access          # get session for active tab
bbx call <method> '{...}'   # any RPC method (raw output)
bbx batch '[{...},...]'     # parallel reads (concurrent)
bbx tabs                    # list available tabs (prefer this)
bbx logs                    # recent bridge request log
bbx tab-create [url]        # open a new tab (avoid unless necessary)
bbx tab-close <tabId>       # close a tab
bbx skill                   # live runtime presets + limits
```

### Inspect & Find

```bash
bbx dom-query [selector]             # query DOM subtree
bbx describe <ref>                   # describe one element
bbx text <ref> [budget]              # element text content
bbx html <ref> [maxLen]              # element HTML
bbx styles <ref> [prop1,prop2,...]   # computed styles
bbx box <ref>                        # box model dimensions
bbx find <text>                      # find by text content
bbx find-role <role> [name]          # find by ARIA role
bbx wait <selector> [timeoutMs]      # wait for DOM element
bbx a11y-tree [maxNodes] [maxDepth]  # accessibility tree
```

### Page & Evaluate

```bash
bbx eval <expression>                # JS eval (- for stdin)
bbx console [level]                  # console output
bbx network [limit]                  # network requests
bbx page-text [budget]               # full page text
bbx storage [local|session] [keys]   # browser storage
bbx perf                             # performance metrics
bbx navigate <url>                   # navigate to URL
bbx resize <width> <height>          # resize viewport
```

### Interact & Patch

```bash
bbx click <ref> [button]             # click element
bbx focus <ref>                      # focus element
bbx type <ref> <text...>             # type into element
bbx press-key <key> [ref]            # send key event
bbx hover <ref>                      # hover over element
bbx patch-style <ref> prop=val...    # apply style patch
bbx patch-text <ref> <text...>       # apply text patch
bbx patches                          # list active patches
bbx rollback <patchId>               # rollback a patch
bbx screenshot <ref> [outPath]       # capture screenshot
```

## Access Request Flow

When you request access to a tab, the user must approve it in the Browser Bridge extension popup. This is normal and expected - there will be a brief delay while the user grants access.

**Retry pattern:**
1. Call `request-access`. If immediate success, proceed.
2. On `APPROVAL_PENDING`, wait ~3 seconds and retry up to 4 more times (the user is likely approving).
3. If all retries fail, output this message and wait:
   
   > "I need access to the browser tab. Please approve the request in the Browser Bridge extension popup, then type **ready** so I can continue."

4. After user responds "ready" (or similar), retry `request-access` once more.

**Do not** repeatedly spam requests - use the retry delays.

## Error Recovery

| Error | Recovery |
|---|---|
| `SESSION_EXPIRED` | Auto-refreshed by CLI; if it fails, `request-access` again |
| `APPROVAL_PENDING` | Wait ~3s, retry up to 4 times; then ask user to approve and type "ready" |
| `ELEMENT_STALE` | Re-query with `dom.query` or `dom.find_by_text` |
| `ORIGIN_MISMATCH` | Tab navigated - `request-access` for new origin |
| `TIMEOUT` | Extension overloaded or CDP stalled - retry once, then simplify the request |
| `CAPABILITY_MISSING` | Session lacks permission - `request-access` with needed capability |
| `DAEMON_OFFLINE` | Daemon not running - start with `bbx-daemon` |
| `CONNECTION_LOST` | Socket dropped mid-request - retry; if persistent, restart daemon |
| `BRIDGE_TIMEOUT` | Extension took too long to respond - retry once with simpler call |

## Core Rules

1. **Work in existing tabs** - Never create new tabs unless the user explicitly asks for it, or the task absolutely requires a fresh page (e.g., testing a clean state, comparing across URLs). Prefer `tabs.list` to find an appropriate existing tab.
2. **Structured first** - `dom.query` → `styles.get_computed` → `layout.get_box_model` before screenshots.
3. **Budget tight** - `maxNodes≤20`, `maxDepth≤4`, `textBudget≤800`. Always set allowlists.
4. **Reuse refs** - use returned `elementRef` for follow-ups; don't rescan.
5. **Style before DOM** - `patch.apply_styles` before `patch.apply_dom`.
6. **Rollback** - revert every patch before finishing unless user wants mutations kept.
7. **Confirm scope** - `status` first; stop if no extension connection.
8. **Screenshots last** - only when structured evidence is ambiguous; keep crops small.
9. **Batch reads** - combine independent reads in one `batch` call (executes concurrently via Promise.all).
10. **Evaluate for state** - use `page.evaluate` to read framework state (React, Vue, Next.js `__NEXT_DATA__`, router, stores) instead of guessing from DOM.
11. **Wait after change** - after editing source files or triggering navigation, use `dom.wait_for` or `page.wait_for_load_state` before inspecting.
12. **Console after interaction** - call `page.get_console` after mutations to catch runtime errors early.
13. **Semantic finding** - use `dom.find_by_text` / `dom.find_by_role` when you know the label but not the selector.
14. **Text extraction** - use `page.get_text` for full page text instead of `dom.query` on body.
15. **Network monitoring** - use `page.get_network` to inspect API calls; auto-installs interceptor.
16. **Accessibility tree** - use `dom.get_accessibility_tree` for semantic structure and interactive element discovery.
17. **Tailwind-aware** - when `page.get_state` returns `hints.tailwind: true`, load `references/tailwind.md`; avoid selecting by utility classes, prefer `find_by_text`/`find_by_role`; `dom.query` auto-escapes `[]` brackets.

## Method Quick Reference

| Category   | Key Methods                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| Session    | `session.request_access`, `session.get_status`, `page.get_state`                         |
| Inspect    | `dom.query`, `dom.describe`, `dom.get_html`, `styles.get_computed`, `layout.get_box_model`|
| Find       | `dom.find_by_text`, `dom.find_by_role`, `dom.wait_for`, `dom.get_accessibility_tree`     |
| Page State | `page.evaluate`, `page.get_console`, `page.get_storage`, `page.get_text`, `page.wait_for_load_state` |
| Network    | `page.get_network`                                                                       |
| Interact   | `input.click`, `input.type`, `input.focus`, `input.press_key`, `input.hover`, `input.drag`|
| Tabs       | `tabs.list` (preferred), `tabs.create` (avoid unless necessary), `tabs.close`           |
| Patch      | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`                                |
| Navigate   | `navigation.navigate`, `viewport.scroll`, `viewport.resize`                              |
| Performance| `performance.get_metrics`                                                                |
| Escalate   | `screenshot.capture_element`, `cdp.*` methods                                            |

## Dev-Server Workflow (HMR-aware)

When the user has a localhost dev server with watch/HMR:

1. **Inspect current state** - `page.get_state` + quick `dom.query` on the relevant area.
2. **Read framework state** - `page.evaluate` to check router, component props, store values.
3. **Identify the problem** - use `styles.get_computed`, `dom.get_html`, or `page.get_console` for errors.
4. **Prototype with patches** - `patch.apply_styles` / `patch.apply_dom` to verify the fix visually.
5. **Edit source files** - modify the actual code in the agent's workspace.
6. **Wait for HMR** - `dom.wait_for` with the selector that should change, or `page.wait_for_load_state`.
7. **Verify the change** - re-inspect the same area; compare with patch expectations.
8. **Check for regressions** - `page.get_console` for new errors; scroll and inspect adjacent areas.
9. **Rollback patches** - `patch.rollback` all temporary patches.

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

- **[Inspection & token efficiency](references/token-efficiency.md)** - budget presets, decision tree, allowlist strategy, anti-patterns
- **[Patching workflows](references/patch-workflow.md)** - style-first loop, DOM patches, verification, cleanup
- **[Full protocol reference](references/protocol.md)** - all RPC methods, error codes
- **[Interaction patterns](references/interaction.md)** - input methods, navigation, form controls, hover, drag, multi-tab workflows
- **[Capabilities reference](references/capabilities.md)** - full capability table, how to request subsets, `CAPABILITY_MISSING` recovery
- **[Tailwind CSS guide](references/tailwind.md)** - selector escaping, semantic alternatives, patching strategy (load when `hints.tailwind: true`)

> **MCP mode:** If Browser Bridge is connected through an MCP server (tools named `browser_dom`, `browser_call`, etc.) rather than the CLI, use those MCP tools directly instead of shelling out to `bbx`. In prompts, `BB MCP` and `Browser Bridge MCP` are both acceptable references. Do not treat `bbx-mcp` as a skill alias in MCP-capable clients.

## Subagent Output

Return: verdict, tab id + origin, minimal evidence set. No raw HTML or base64 images.

## Output Format

Every CLI shortcut command produces consistent `{ok, summary, evidence}` JSON. Use `bbx call <method>` for raw protocol output when needed.

## Response Shapes

The summarizer auto-detects response types and produces concise summaries:

Shortcut commands intentionally expose only the common case. Use `bbx call <method> '{...}'` when you need method-specific fields that are not surfaced by a shortcut, such as `tabs.create.active`.

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

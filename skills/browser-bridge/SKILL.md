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
bbx doctor                  # install/access readiness
bbx call <method> '{...}'   # any RPC method (raw output)
bbx call --tab 123 <method> '{...}' # explicit tab override
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

## Access Flow

Browser Bridge access is window-scoped. The user turns it on once for the current browser window in the popup or side panel.

There is no separate "request access" command anymore. Agents should just make the intended Browser Bridge call.

If the first tab-bound call fails with `ACCESS_DENIED` because Browser Bridge is off:
1. That failed call already surfaces an enable cue in the extension popup/side panel for the relevant window.
2. Ask the user to open the Browser Bridge popup or side panel and click `Enable`.
3. After the user confirms, retry the same call once.

After access is enabled:
1. Default routing follows the active tab in that enabled window.
2. If the user switches tabs in that window, Browser Bridge follows automatically.
3. Use `tabId` only when you intentionally need a non-active tab in the same enabled window.
4. Do not stop at a generic "no access" message before making a real Browser Bridge call, because the first denied call is what triggers the UI cue.

## Error Recovery

| Error | Recovery |
|---|---|
| `ACCESS_DENIED` | The failed call already surfaced an `Enable` cue in the extension UI; ask the user to click `Enable` in the popup/side panel, then retry once |
| `ELEMENT_STALE` | Re-query with `dom.query` or `dom.find_by_text` |
| `TIMEOUT` | Extension overloaded or CDP stalled - retry once, then simplify the request |
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
10. **Avoid debugger first** - prefer DOM/content-script methods (`dom.*`, `styles.*`, `layout.get_box_model`, `page.get_console`, `page.get_text`, `page.get_storage`, `page.get_network`) before any debugger-backed method. Escalate to CDP only when those cannot answer the question.
11. **Evaluate only when needed** - `page.evaluate` is powerful but debugger-backed; use it only when DOM, storage, console, network, or text reads cannot expose the needed state.
12. **Debugger-backed methods are last resort** - treat `page.evaluate`, `dom.get_accessibility_tree`, `viewport.resize`, `performance.get_metrics`, `screenshot.capture_*`, and all `cdp.*` methods as escalation steps because they attach `chrome.debugger`.
13. **Wait after change** - after editing source files or triggering navigation, use `dom.wait_for` or `page.wait_for_load_state` before inspecting.
14. **Console after interaction** - call `page.get_console` after mutations to catch runtime errors early.
15. **Semantic finding** - use `dom.find_by_text` / `dom.find_by_role` when you know the label but not the selector.
16. **Text extraction** - use `page.get_text` for full page text instead of `dom.query` on body.
17. **Network monitoring** - use `page.get_network` to inspect API calls; auto-installs interceptor.
18. **Accessibility tree only when necessary** - `dom.get_accessibility_tree` is debugger-backed; use it when semantic structure cannot be inferred from DOM queries and role/text search.
19. **Tailwind-aware** - when `page.get_state` returns `hints.tailwind: true`, load `references/tailwind.md`; avoid selecting by utility classes, prefer `find_by_text`/`find_by_role`; `dom.query` auto-escapes `[]` brackets.

## Method Quick Reference

| Category   | Key Methods                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| Access     | `health.ping`, `tabs.list`, `page.get_state`                                             |
| Inspect    | `dom.query`, `dom.describe`, `dom.get_html`, `styles.get_computed`, `layout.get_box_model`|
| Find       | `dom.find_by_text`, `dom.find_by_role`, `dom.wait_for`, `dom.get_accessibility_tree`     |
| Page State | `page.get_console`, `page.get_storage`, `page.get_text`, `page.wait_for_load_state`, `page.evaluate` (debugger-backed) |
| Network    | `page.get_network`                                                                       |
| Interact   | `input.click`, `input.type`, `input.focus`, `input.press_key`, `input.hover`, `input.drag`|
| Tabs       | `tabs.list` (preferred), `tabs.create` (avoid unless necessary), `tabs.close`           |
| Patch      | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`                                |
| Navigate   | `navigation.navigate`, `viewport.scroll`, `viewport.resize`                              |
| Performance| `performance.get_metrics` (debugger-backed)                                              |
| Escalate   | `dom.get_accessibility_tree`, `screenshot.capture_element`, `screenshot.capture_region`, `viewport.resize`, `cdp.*` methods |

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
- **[UI development workflows](references/ui-workflows.md)** - localhost HMR, form triage, design QA, responsive checks, hover/drag, accessibility
- **[Full protocol reference](references/protocol.md)** - all RPC methods, error codes
- **[Interaction patterns](references/interaction.md)** - input methods, navigation, form controls, hover, drag, multi-tab workflows
- **[Access and method coverage](references/capabilities.md)** - window-scoped access model and method group overview
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
| Health ping | `result.daemon` | `Daemon: ok. Extension: connected/disconnected. Access: ...` |
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

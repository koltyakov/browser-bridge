---
name: browser-bridge
description: 'Token-efficient Chrome tab inspection, interaction, and patching via local bridge extension (CLI: bbx). Reads live DOM, styles, console, network, and storage from a real Chrome tab with lower token cost than screenshots.'
---

# Browser Bridge

Token-efficient Chrome tab inspection, interaction, and CSS/DOM patching through a local native-messaging bridge. Reads structured DOM, styles, layout, console, storage, network, and applies reversible patches - all from the real tab the user already has open.

This CLI skill is for agents that can run shell commands and where direct `bbx` control fits better than MCP tools: manual debugging, terminal reproduction, install/doctor flows, raw protocol access, or environments without MCP.

Permission prompts are controlled by the host agent, not by Browser Bridge. In permission-ask MCP hosts, use the generic `browser_call` MCP tool by default so the user can approve one BBX tool instead of separate status, page, DOM, input, and patch tools. In Claude Code CLI mode, allow `bbx` with `Bash(bbx *)` when direct shell access is desired. Exact permission syntax varies by client.

Skill name: `browser-bridge` (also known as `bbx`). In GitHub Copilot, invoke as `/browser-bridge`. `bbx` is the CLI command used throughout this skill.
When the runtime supports subagents, delegate bridge inspection to a smaller, lower-cost worker and return only concise findings to the parent.
For open-ended investigation, start with structured reads (`page.get_state`, `dom.query`, `page.get_text`, `page.extract_content`, `styles.get_computed`, and `bbx batch` for CLI or `browser_batch` for MCP) and escalate to screenshots or debugger-backed methods only when structured evidence is insufficient. `browser_call` accepts one protocol method at a time; `batch` is not a valid `browser_call` method.

## CLI

```bash
bbx status                  # daemon + extension health
bbx doctor                  # consolidated local diagnostics (does not probe remotes)
bbx access-request          # ask user to enable access for the focused window
bbx restart                 # start/restart the daemon and running MCP servers
bbx call <method> '{...}'   # any RPC method (raw output)
bbx <method> '{...}'        # direct alias for an exact bridge method such as page.get_state
bbx call --tab 123 <method> '{...}' # explicit tab override
bbx batch '[{...},...]'     # parallel reads (concurrent)
bbx tabs                    # list available tabs (prefer this)
bbx logs                    # recent bridge request log
bbx tab-create [url]        # open a new tab (avoid unless necessary)
bbx tab-close <tabId>       # close a tab
bbx tab-activate <tabId>    # bring a tab to the foreground
bbx skill                   # live runtime presets + limits
```

Use the globally installed `bbx` command or `node packages/agent-client/src/cli.js ...` for live readiness checks from this repository. Avoid `rtk npm exec -- bbx status` as a health signal: that path can restart/replace the daemon and report `Extension: disconnected` before Chrome reconnects. If it happens, wait a few seconds and verify with `bbx status`.

### Inspect & Find

```bash
bbx dom-query [selector]             # query DOM subtree
bbx describe <ref>                   # describe one element
bbx text <ref> [budget]              # element text content
bbx html <ref> [maxLen]              # element HTML
bbx styles <ref> [prop1,prop2,...]   # computed styles
bbx attrs <ref> [attr1,attr2,...]    # element attributes
bbx matched-rules <ref>              # matched CSS rules
bbx box <ref>                        # box model dimensions
bbx find <text>                      # find by text content
bbx find-role <role> [name]          # find by ARIA role
bbx wait <selector> [timeoutMs]      # wait for DOM element
bbx a11y-tree [maxNodes] [maxDepth]  # accessibility tree
```

### Page & Evaluate

```bash
bbx eval [--await] <expression>      # JS eval (--await for promises, - for stdin)
bbx console [level]                  # console output
bbx network [limit]                  # recent fetch/XHR requests
bbx intercept add <pattern> [--respond <body>] [--status <code>] [--block]  # intercept matching requests
bbx intercept list|remove <id>|clear # manage interception rules
bbx page-text [budget]               # full page text
bbx storage [local|session] [keys]   # browser storage
bbx perf                             # performance metrics
bbx navigate <url>                   # navigate to URL
bbx reload                           # reload current page
bbx back                             # navigate back
bbx forward                          # navigate forward
bbx scroll <top> [left]              # scroll viewport
bbx resize <width> <height>          # resize viewport
bbx call page.wait_for_load_state '{"url":"/dashboard","urlMatch":"contains","waitForLoad":false}'
bbx call page.handle_dialog '{"action":"inspect"}' # inspect current JS dialog; never auto-accept
```

### Interact & Patch

```bash
bbx click <ref> [button]             # click element
bbx focus <ref>                      # focus element
bbx type <ref> <text...>             # type into element
bbx fill <ref|selector> <value...>   # set input value (React/Vue/Angular-safe)
bbx press-key <key> [ref]            # send key event
bbx cdp-press-key --tab <id> Escape  # CDP key event without foreground focus
bbx hover <ref>                      # hover over element
bbx call input.scroll_into_view '{"target":{"elementRef":"el_123"}}' # ensure target is visible
bbx call input.click '{"target":{"elementRef":"el_123"},"executionMode":"cdp"}' # optional native click
bbx patch-style <ref> prop=val...    # apply style patch
bbx patch-text <ref> <text...>       # apply text patch
bbx patches                          # list active patches
bbx rollback <patchId>               # rollback a patch
bbx screenshot [--format png|jpeg|webp] [--quality 0-100] <ref> [outPath] # complete element capture
bbx call screenshot.capture_full_page '{}' # raw base64; avoid unless document context matters
```

### Remote Destinations

Every bridge command accepts `--remote <name>` (or `BBX_REMOTE=<name>` env) to target a browser on another machine registered with `bbx remote add`:

```bash
bbx remote list                      # configured remote destinations
bbx remote test <name>               # ping a remote through the proxy
bbx tabs --remote <name>             # any bridge command works with --remote
bbx dom-query "#app" --remote <name>
```

In MCP mode, pass `destinationId` on any browser tool call instead; `browser_status` lists all destinations with reachability. Only use remotes the user has configured; local remains the default.

`bbx doctor` is intentionally local-only. It reports how many remotes are configured, but marks their status `not_probed_local_only` and credentials `unverified`; use `bbx remote test <name>` when the user wants a remote probe.

## Access Flow

Browser Bridge access is window-scoped. The user turns it on once for the current browser window in the popup or side panel.

To request access, call `access.request` (via `bbx access-request`, `browser_access` MCP tool, or `bbx call access.request`). This surfaces an Enable cue in the extension popup/side panel for the focused window.

Do not call `access.request` repeatedly while the same window is still pending. If access is already requested, tell the user to enable that window and wait for them to confirm readiness.

If a tab-bound call fails with `ACCESS_DENIED` because Browser Bridge is off, that failed call also surfaces an enable cue automatically.

After the Enable cue appears:

1. Ask the user to open the Browser Bridge popup or side panel and click `Enable`.
2. After the user confirms, retry the call.

After access is enabled:

1. Default routing follows the active tab in that enabled window.
2. If the user switches tabs in that window, Browser Bridge follows automatically.
3. Use `tabId` only when you intentionally need a non-active tab in the same enabled window.
4. Do not stop at a generic "no access" message before making a real Browser Bridge call, because the first denied call is what triggers the UI cue.

## Error Recovery

| Error                     | Retry?   | Recovery                                                                                  |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `ACCESS_DENIED`           | No       | Failed call already surfaced an `Enable` cue; ask user to click `Enable`, then retry once |
| `ELEMENT_STALE`           | No       | Re-query with `dom.query` or `dom.find_by_text` to get a fresh ref                        |
| `ELEMENT_AMBIGUOUS`       | No       | Narrow the selector or use an explicit `elementRef`; do not guess                         |
| `ELEMENT_NOT_ACTIONABLE`  | No       | Inspect hidden/disabled/inert state with `dom.describe`                                   |
| `ELEMENT_OBSCURED`        | No       | Inspect bounded blocker details or use `layout.hit_test`                                  |
| `INPUT_FOCUS_CHANGED`     | No       | Inspect focus handlers; do not replay native text automatically                           |
| `DIALOG_NOT_OPEN`         | No       | Trigger or inspect the dialog again                                                       |
| `DIALOG_ACTION_CONFLICT`  | No       | Inspect current dialog state; never auto-repeat accept/dismiss                            |
| `TAB_MISMATCH`            | No       | Tab closed or not found - use `tabs.list` to find an available tab                        |
| `TIMEOUT`                 | Once     | Retry once; if still failing, simplify (smaller `maxNodes`, narrower selector)            |
| `RATE_LIMITED`            | After 2s | Back off 2 seconds, then retry                                                            |
| `EXTENSION_DISCONNECTED`  | After 3s | Check Chrome is running; `bbx status` to verify, then retry                               |
| `NATIVE_HOST_UNAVAILABLE` | No       | Run `bbx doctor` to diagnose the installation                                             |
| `INTERNAL_ERROR`          | Once     | Retry once; if persistent, check `page.get_console` for details                           |
| `DAEMON_OFFLINE`          | No       | Daemon not running - start with `bbx restart`                                             |
| `CONNECTION_LOST`         | Yes      | Socket dropped mid-request - retry; if persistent, run `bbx restart`                      |
| `BRIDGE_TIMEOUT`          | Once     | Extension took too long - retry once with simpler call                                    |

Error responses now include a machine-readable `error.recovery` field with `retry`, `retryAfterMs`, `alternativeMethod`, and `hint`.

## Core Rules

1. **Work in existing tabs** - Never create new tabs unless the user explicitly asks for it, or the task absolutely requires a fresh page (e.g., testing a clean state, comparing across URLs). Prefer `tabs.list` to find an appropriate existing tab.
2. **Structured first** - `dom.query` → `styles.get_computed` → `layout.get_box_model` before screenshots.
3. **Budget tight** - `maxNodes≤20`, `maxDepth≤4`, `textBudget≤800`. Always set allowlists.
4. **Reuse refs** - use returned `elementRef` for follow-ups; don't rescan.
5. **Style before DOM** - `patch.apply_styles` before `patch.apply_dom`.
6. **Rollback** - revert every patch before finishing unless user wants mutations kept.
7. **Confirm scope** - `status` first; stop if no extension connection.
8. **Screenshots last** - only when structured evidence is ambiguous; prefer `screenshot.capture_element`, then a tight `screenshot.capture_region`; use `screenshot.capture_full_page` only when document-level context matters.
9. **Batch reads** - combine independent reads with `bbx batch` in CLI mode or `browser_batch` in MCP mode; do not pass `batch` as a `browser_call` method.
10. **Avoid debugger first** - prefer DOM/content-script methods (`dom.*`, `styles.*`, `layout.get_box_model`, `page.get_console`, `page.get_text`, `page.get_storage`, `page.get_network`) before any debugger-backed method. Escalate to CDP only when those cannot answer the question.
11. **Evaluate only when needed** - `page.evaluate` is powerful but debugger-backed; use it only when DOM, storage, console, network, or text reads cannot expose the needed state.
12. **Debugger-backed methods are last resort** - treat `page.evaluate`, `page.handle_dialog`, `dom.get_accessibility_tree`, `page.get_network` with `source: 'cdp'`, input with `executionMode: 'cdp'`, `viewport.resize`, `performance.get_metrics`, `screenshot.capture_*`, and all `cdp.*` methods as escalation steps because they attach `chrome.debugger`.
13. **Wait after change** - after editing source, wait for expected new text, a selector matching the changed attribute, or a detach/attach remount; waiting for `attached` on a selector that already exists does not prove HMR ran. Use `page.wait_for_load_state` for navigation, not HMR.
14. **Prime event buffers** - before reproducing a console or fetch/XHR issue, call `page.get_console` and default `page.get_network` once with `clear: true`; then reproduce and read without clearing. CDP all-resource capture instead requires explicit `start`, reproduce, `read`, and `stop` calls.
15. **Semantic finding** - use `dom.find_by_text` / `dom.find_by_role` when you know the label but not the selector.
16. **Text extraction** - use `page.extract_content` for articles/documentation, or `page.get_text` for all visible UI text, instead of `dom.query` on body.
17. **Network monitoring** - use `page.get_network` to inspect API calls; auto-installs interceptor.
18. **Accessibility tree only when necessary** - `dom.get_accessibility_tree` is debugger-backed; use it when semantic structure cannot be inferred from DOM queries and role/text search.
19. **Tailwind-aware** - when `page.get_state` returns `hints.tailwind: true`, load `references/tailwind.md`; avoid selecting by utility classes, prefer `find_by_text`/`find_by_role`; `dom.query` auto-escapes `[]` brackets.
20. **Verify after input** - a dispatched DOM or CDP event does not prove application state changed. Follow it with the cheapest relevant wait or structured read.
21. **Do not guess input targets** - for targeted click, focus, type, fill, press-key, checked-state, option-selection, hover, and drag calls, honor actionability errors and returned `resolution` metadata. `cdp_press_key` and `scroll_into_view` use separate contracts. `executionMode` is only `dom` or `cdp`; `input.fill.mode: auto` is a separate DOM setter/keystroke strategy.
22. **Stale recovery stays opt-in** - prefer re-querying. Use `recoverStale: true` once only when the same document/URL and a strong unique semantic descriptor should still identify the target; inspect `recovered`, old/new refs, and matched fields. A scan with more than 100 same-tag candidates fails as `ELEMENT_AMBIGUOUS`/`scan_incomplete` because uniqueness is not provable.
23. **Dialogs are explicit** - inspect first, then accept or dismiss only when intended. `expectedDialogId` is a pre-dispatch stale-decision check, not an atomic CDP binding; never auto-repeat `DIALOG_ACTION_CONFLICT`.

## Token Budget Quick Rules

1. **Start with `quick` budget** - widen to `normal` or `deep` only if `budget_truncated: true`
2. **Use `attributeAllowlist`** - filter irrelevant attributes (e.g. `['class', 'href', 'data-testid']`)
3. **Batch independent reads** - combine into a single `bbx batch` / `browser_batch` call
4. **Refresh refs after pruning** - if `dom.query` returns `_registryPruned: true`, old refs may have been evicted; re-query before reusing them
5. **Watch overflow counters** - `page.get_console` and `page.get_network` return `dropped` when hot pages overflow the 200-entry buffers; CDP network also reports `abandoned` and capture lifecycle state

## Investigate Workflow

For a natural-language inspection task:

1. Use a small, cheap subagent if the parent runtime supports delegation.
2. Start with `page.get_state` plus a narrow `dom.query` or one `bbx batch` combining independent reads.
3. Add `page.get_text`, `styles.get_computed`, `layout.get_box_model`, `page.get_console`, or `page.get_network` only when they directly help answer the objective.
4. Escalate to `screenshot.capture_element`, `screenshot.capture_region`, or other debugger-backed methods only when structured reads are ambiguous or visual confirmation is required.
5. Return concise findings and evidence, not raw dumps.

CLI-first starter:

```bash
bbx batch '[{"method":"page.get_state"},{"method":"dom.query","params":{"selector":"main","maxNodes":10,"maxDepth":3,"textBudget":400,"attributeAllowlist":["id","class","data-testid"]}},{"method":"page.get_text","params":{"textBudget":2000}}]'
```

## Common Workflows

### Debug a CSS layout issue

```bash
bbx status                                         # confirm connection
bbx dom-query '.broken-component'                  # inspect the DOM subtree
bbx styles ref_abc123 display,flex-direction,gap    # check computed styles
bbx patch-style ref_abc123 display=flex gap=8px     # prototype a fix
bbx box ref_abc123                                  # verify dimensions
bbx rollback patch_1                                # clean up
# → edit source file with the confirmed fix
```

### Find and fix broken text content

```bash
bbx find 'Error: something went wrong'             # locate the error text
bbx describe ref_xyz789                             # understand the element
bbx html ref_xyz789 500                             # check surrounding markup
bbx patch-text ref_xyz789 'Updated message'         # test replacement
bbx text ref_xyz789                                 # verify the change
bbx rollback patch_2                                # clean up
```

### Verify an API call

```bash
bbx call page.get_console '{"clear":true}'          # install + clear console capture
bbx call page.get_network '{"clear":true}'          # install + clear network capture
# reproduce the API action here
bbx console error                                   # read newly captured runtime errors
bbx network 20                                      # read newly captured requests
bbx eval 'document.querySelector("#app").__vue__.$store.state.user'  # read framework state
bbx page-text 2000                                  # extract page content
```

## Method Quick Reference

| Category    | Key Methods                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access      | `access.request`, `health.ping`, `tabs.list`, `page.get_state`                                                                                      |
| Inspect     | `dom.query`, `dom.describe`, `dom.get_html`, `styles.get_computed`, `layout.get_box_model`                                                          |
| Find        | `dom.find_by_text`, `dom.find_by_role`, `dom.wait_for`, `dom.get_accessibility_tree`                                                                |
| Page State  | `page.get_console`, `page.get_storage`, `page.get_text`, `page.wait_for_load_state`, `page.evaluate` (debugger-backed)                              |
| Dialogs     | `page.handle_dialog` (debugger-backed; explicit inspect/accept/dismiss only)                                                                  |
| Network     | `page.get_network` (fetch/XHR default; optional CDP lifecycle), `network.intercept.add/remove/list/clear` (debugger-backed)                         |
| Interact    | `input.click`, `input.type`, `input.fill`, `input.focus`, `input.press_key`, `cdp.dispatch_key_event`, `input.hover`, `input.drag`, `input.scroll_into_view` |
| Tabs        | `tabs.list` (preferred), `tabs.create` (avoid unless necessary), `tabs.close`, `tabs.activate`                                                      |
| Patch       | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`                                                                                           |
| Navigate    | `navigation.navigate`, `viewport.scroll`, `viewport.resize`                                                                                         |
| Performance | `performance.get_metrics` (debugger-backed)                                                                                                         |
| Escalate    | `dom.get_accessibility_tree`, `screenshot.capture_element`, `screenshot.capture_region` (tight crops only), `screenshot.capture_full_page`, `cdp.*` |

## Dev-Server Workflow (HMR-aware)

When the user has a localhost dev server with watch/HMR:

1. **Inspect current state** - `page.get_state` + quick `dom.query` on the relevant area.
2. **Read framework state** - `page.evaluate` to check router, component props, store values.
3. **Identify the problem** - use `styles.get_computed`, `dom.get_html`, or `page.get_console` for errors.
4. **Prototype with patches** - `patch.apply_styles` / `patch.apply_dom` to verify the fix visually.
5. **Edit source files** - modify the actual code in the agent's workspace.
6. **Wait for HMR** - use `dom.wait_for` for expected new text, a selector matching the changed attribute, or a detach/attach remount. Do not wait for `attached` on an unchanged selector that already exists.
7. **Verify the change** - re-inspect the same area; compare with patch expectations.
8. **Check for regressions** - `page.get_console` for new errors; scroll and inspect adjacent areas.
9. **Rollback patches** - `patch.rollback` all temporary patches.

## Investigate-a-Bug Workflow

```
page.get_state → page.get_console(clear: true) + page.get_network(clear: true)
  → reproduce the bug → page.get_console + page.get_network
  → dom.find_by_text('<error text>') or dom.query('<selector>')
  → styles.get_computed (check layout/visibility)
  → page.evaluate('document.querySelector(...).dataset') (read data attrs)
  → page.evaluate('window.__APP_STATE__') (read framework state)
  → patch.apply_styles (test fix) → verify → edit source → wait for HMR → verify
```

## User-Flow Testing Workflow

```
dom.find_by_role('button', 'Login') → input.click
  → page.wait_for_load_state({url: '/dashboard', urlMatch: 'contains', waitForLoad: false})
  → dom.wait_for('.dashboard', {state: 'visible', timeoutMs: 10000})
  → page.get_console (check for errors)
  → dom.query('.dashboard', {maxNodes: 15}) (inspect result)
```

## Detailed References (load only when needed)

- **[Inspection & token efficiency](references/token-efficiency.md)** - budget presets, decision tree, allowlist strategy, anti-patterns
- **[Patching workflows](references/patch-workflow.md)** - style-first loop, DOM patches, verification, cleanup
- **[UI development workflows](references/ui-workflows.md)** - localhost HMR, form triage, design QA, responsive checks, hover/drag, accessibility
- **[Full protocol reference](references/protocol.md)** - all RPC methods, error codes, and per-method capability mapping
- **[Interaction patterns](references/interaction.md)** - input methods, navigation, form controls, hover, drag, multi-tab workflows
- **[Access and routing summary](references/capabilities.md)** - window-scoped access model and explicit-tab routing rules
- **[Tailwind CSS guide](references/tailwind.md)** - selector escaping, semantic alternatives, patching strategy (load when `hints.tailwind: true`)

`bbx a11y-tree` and `dom.get_accessibility_tree` are sensitive to `maxDepth` and `maxNodes`. Shallow runs can undercount interactive nodes on real pages, so widen those limits before treating a low interactive count as a bug.

For control discovery, prefer `compact: true` or `interactiveOnly: true`, then use role/name with `dom.find_by_role` to obtain an input ref. AX `interactive` means semantic/focusable, not currently visible, unobscured, or otherwise actionable; AX results are depth-limited partial topology and include truncation metadata even when `maxNodes` was not reached.

> **MCP mode:** If Browser Bridge is connected via MCP (tools named `browser_dom`, `browser_capture`, etc.), use the MCP tools directly - do not shell out to `bbx`. The MCP tools map 1:1 to CLI capabilities. In prompts, `BB MCP` and `Browser Bridge MCP` both work. Do not treat `bbx-mcp` as a skill alias.
>
> For open-ended MCP inspection tasks, prefer `browser_investigate` first. It is read-only, designed for cheaper delegated investigation, and falls back to a deterministic sequence when the client cannot delegate. Escalate to `browser_capture` only when the structured investigation is not enough.

## Subagent Output

Return: verdict, tab id + origin, minimal evidence set. No raw HTML or base64 images.

## Output Format

Every CLI shortcut command produces consistent `{ok, summary, evidence}` JSON. Use `bbx call <method>` for raw protocol output when needed.

## CLI Raw Params Gotchas

- Use `selector`, not `scope`, to narrow `dom.find_by_text` and `dom.find_by_role`.
- Wrap targeted DOM input as `target: { elementRef }` or `target: { selector }`; `input.press_key` may omit the target to use the active element, `input.scroll_into_view` also accepts `target`, and `cdp.dispatch_key_event` targets the tab. **Do not pass `ref` or `elementRef` at the top level**:
  ```bash
  # CORRECT
  bbx call input.click '{"target":{"elementRef":"el_xxx"}}'
  bbx call input.type  '{"target":{"elementRef":"el_xxx"},"text":"hello"}'
  # WRONG -- will fail with "Target not found"
  bbx call input.click '{"ref":"el_xxx"}'
  bbx call input.click '{"elementRef":"el_xxx"}'
  ```
- `input.drag` uses `source`, `destination`, and optional destination offsets `offsetX` / `offsetY`.
- `executionMode` accepts `dom` or `cdp` and defaults to `dom`; CDP supports only click, hover, drag, type, and fill. `input.fill.mode` (`auto`, `setter`, `keystrokes`) is a separate DOM strategy.
- `page.get_network` defaults to low-cost fetch/XHR instrumentation. All-resource CDP capture must be armed before the activity with `source: "cdp", capture: "start"`, read later, and explicitly stopped.
- `page.handle_dialog` mutations are not atomically bound to `expectedDialogId`; treat `commandDispatched` as dispatch evidence and verify follow-up state.
- Raw `screenshot.capture_region` and `screenshot.capture_full_page` return base64 JSON; prefer `bbx screenshot <ref> [outPath]` when one element is enough.

## Response Shapes

The summarizer auto-detects response types and produces concise summaries:

Shortcut commands intentionally expose only the common case. Use `bbx call <method> '{...}'` when you need method-specific fields that are not surfaced by a shortcut, such as `tabs.create.active`.

`dom.query` results include `registrySize` and may include `_registryPruned: true` after element-ref eviction. `page.get_console` and `page.get_network` include `dropped` when older buffered entries were discarded. Targeted click, focus, type, fill, press-key, checked-state, option-selection, hover, and drag results include bounded `resolution` and `execution` metadata; `cdp_press_key` and `scroll_into_view` use separate contracts.

| Response Type    | Detection                        | Summary Format                                               |
| ---------------- | -------------------------------- | ------------------------------------------------------------ |
| Health ping      | `result.daemon`                  | `Daemon: ok. Extension: connected/disconnected. Access: ...` |
| Tab list         | `result.tabs`                    | `Bridge listed N tab(s).`                                    |
| Page state       | `result.url + title + origin`    | `Page: Title (origin) [hints].`                              |
| Page/DOM text    | `result.text/value + truncated`  | `Page text: N chars.`                                        |
| DOM nodes        | `result.nodes`                   | `DOM query returned N node(s).`                              |
| A11y tree        | `result.nodes + role`            | `Accessibility tree: N nodes (M interactive).`               |
| Evaluate         | `result.value + type`            | `Evaluated to type: value`                                   |
| Element describe | `result.tag + elementRef + bbox` | `Element tag#id: text.`                                      |
| Computed styles  | `result.properties + elementRef` | `Computed N style(s) for ref.`                               |
| Box model        | `result.content + border`        | `Box model: W×H at (x, y).`                                  |
| Network          | `result.source + entries`        | `Network: N requests.`                                       |
| Console          | `entries` (no type field)        | `Console: N entries.`                                        |
| Logs             | `entries[0].at + method`         | `Log: N entries.`                                            |
| Patch apply      | `result.patchId`                 | `Patch id applied.`                                          |
| Patch rollback   | `result.rolled_back`             | `Patch rolled back.`                                         |
| Patch list       | `result.patches`                 | `N active patch(es).`                                        |
| HTML             | `result.html`                    | `HTML fragment: N chars.`                                    |
| Performance      | `result.metrics`                 | `Performance: N metrics collected.`                          |
| Storage          | `result.type + count + entries`  | `Storage (type): N entries.`                                 |
| Click/Focus/Type | `result.clicked/focused/typed`   | `Clicked/Focused/Typed ref.`                                 |
| Key press        | `result.pressed`                 | `Key pressed (key).`                                         |
| Navigate         | `result.navigated`               | `Navigated to url.`                                          |
| Scroll           | `result.scrolled`                | `Scrolled to (x, y).`                                        |
| Resize           | `result.resized`                 | `Viewport resized to W×H.`                                   |
| Hover            | `result.hovered`                 | `Hover active/failed on ref.`                                |
| Drag             | `result.dragged`                 | `Drag completed/failed.`                                     |
| Tab close        | `result.closed`                  | `Tab N closed.`                                              |
| Tab create       | `result.tabId + url`             | `Tab N created (url).`                                       |

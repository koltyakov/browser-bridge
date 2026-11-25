# CLI Reference

Load when calling raw `bbx call` methods or reading CLI summaries.

## Output Format

Every CLI shortcut command produces consistent `{ok, summary, evidence}` JSON, plus `transportTokens` when the raw result is above 250 tokens. Use `bbx call <method>` for raw protocol output when needed; it prints the bare result, or `{ok: false, error, recovery}` on failure.

CLI batches keep fuller `response` values when bounded `evidence` omits information. Use `--evidence-only` to omit those values for smaller agent output; `responseOmitted: true` marks affected items. The default remains lossless. `protocol.describe` can share a CLI or MCP batch with page reads and runs locally; discovery-only batches need no daemon. Text summaries show returned/source character counts when they differ, such as `Page text: 600/3015 chars (truncated).` Evidence previews can be shorter than the bridge result.

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
- `executionMode` accepts `dom` or `cdp` and defaults to `dom`; CDP supports click, hover, drag, type, fill, press_key, and touch. `input.fill.mode` (`auto`, `setter`, `keystrokes`) is a separate DOM strategy.
- `input.perform` takes `steps: [{ method, params, atMs | delayMs }]` using the same params each method takes alone. Steps run in order inside the extension; it stops at the first failed step (or a `dom.wait_for` that times out) unless `continueOnError: true`, and reports `startedAtMs` for every step. It also accepts `page.get_state`, `page.get_text`, `dom.query`, `dom.get_text`, and DOM-outline `dom.get_accessibility_tree` read steps. `returnLastResult: true` retains only the final successful step's bounded result; a failed final step never substitutes an earlier result.
- `page.get_network` defaults to low-cost fetch/XHR instrumentation. All-resource CDP capture must be armed before the activity with `source: "cdp", capture: "start"`, read later, and explicitly stopped.
- `network.export_har` requires that explicit capture to still be armed. Params are `limit` (1-200), sanitized-URL substring `urlPattern`, and `delivery` (`auto`, `inline`, `artifact`). Inline bounds remove whole oldest entries; export never changes capture state. `bbx har` uses the same client to download, length/SHA-256 verify, delete, validate, and atomically write artifacts locally.
- `page.handle_dialog` mutations are not atomically bound to `expectedDialogId`; treat `commandDispatched` as dispatch evidence and verify follow-up state.
- Raw screenshot calls default to inline base64. Use `delivery: "auto"` for size-aware artifact fallback, or explicit `inline` when MCP image content is required; prefer `bbx screenshot <ref> [outPath]` when one element is enough because the CLI downloads and verifies artifacts locally.
- Artifact delivery returns a descriptor (artifactId, sha256, byteLength), not bytes. From MCP, read chunks with the `browser_artifact` tool (`action: "read"`, paging `offset` until `nextOffset` is null, then verify the reassembled bytes against `sha256`) and free storage with `action: "delete"`. Each standalone CLI invocation has a new artifact owner, so use `bbx screenshot` / `bbx har` to capture, download, verify, and delete within one CLI process; use `delivery: "inline"` for raw CLI screenshot calls that need the bytes in their immediate result.

## Response Shapes

The summarizer auto-detects response types and produces concise summaries:

Shortcut commands intentionally expose only the common case. Use `bbx call <method> '{...}'` when you need method-specific fields that are not surfaced by a shortcut, such as `tabs.create.active`.

`dom.query` results include `registrySize` and may include `_registryPruned: true` after element-ref eviction. `page.get_console` and `page.get_network` include `dropped` when older buffered entries were discarded. Console summary entries with a stack add `at`, the top frame as `function (file:line:column)`, preferring the source-mapped position. Targeted click, focus, type, fill, press-key, checked-state, option-selection, hover, and drag results include bounded `resolution` and `execution` metadata; `cdp_press_key` and `scroll_into_view` use separate contracts.

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
| HAR export       | `result.format === "har"`        | `HAR export delivered mode: N/M entries.`                    |
| Console          | `entries` (no type field)        | `Console: N entries.`                                        |
| Logs             | `entries[0].at + method`         | `Log: N entries.`                                            |
| Patch apply      | `result.patchId`                 | `Patch id applied.`                                          |
| Patch rollback   | `result.rolled_back`             | `Patch rolled back.`                                         |
| Patch list       | `result.patches`                 | `N active patch(es).`                                        |
| HTML             | `result.html`                    | `HTML fragment: N chars.`                                    |
| Performance      | `result.metrics`                 | `Raw CDP performance counters: N collected; Web Vitals not measured.` |
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

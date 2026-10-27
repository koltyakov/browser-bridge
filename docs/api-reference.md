# CLI and Wire API Reference

Browser Bridge exposes browser methods through the Go CLI, MCP server, and
authenticated daemon wire protocol. The npm package bootstraps and launches
the Go executable; it does not export a JavaScript client API.

If you are setting up Browser Bridge for normal end-user agent usage, start with
[quickstart](./quickstart.md) or [manual setup](./manual-setup.md) instead.

## Raw CLI calls

```bash
npm install -g @browserbridge/bbx
bbx call health.ping '{}'
bbx protocol describe dom.query
```

Discover connections and tabs, then reuse the selected connection ID and tab ID:

```bash
bbx call tabs.list '{}'
bbx call --extension '<connection ID>' --tab 123 --preset quick dom.query '{"selector":"h1","maxNodes":5}'
```

`bbx call` prints the raw bridge response. Shortcuts such as `bbx dom-query`
print `{ok, summary, evidence}`. For automation, parse JSON stdout and check
`ok`; keep diagnostics on stderr separate. Use `bbx batch` for independent
reads and `input.perform` for ordered browser actions. See [CLI guide](./cli-guide.md).

## Daemon wire protocol

The Go transport implementation lives in `internal/bridge/client.go` and
`wire.go`. Canonical message types live in [`protocol/types.ts`](../protocol/types.ts).
Messages are newline-delimited JSON over the configured local socket, TCP
connection, or Windows named pipe. Native Messaging uses a separate four-byte
little-endian length prefix between Chrome and the native host.

Register an agent before sending requests. The following shows message shapes;
replace the credential placeholder with the configured agent token:

```json
{"type":"register","role":"agent","clientId":"my-tool-session","authToken":"<agent credential>"}
```

Wait for `{"type":"registered","role":"agent"}` before sending an
`agent.request`. Use a unique request ID and correlate it with the response ID.
The wire field is `tab_id`; CLI and MCP adapters accept their documented tab selectors.

```json
{
  "type": "agent.request",
  "request": {
    "id": "req_health_1",
    "method": "health.ping",
    "params": {},
    "tab_id": null,
    "meta": {"protocol_version": "1.14", "token_budget": null}
  }
}
```

The example version is illustrative; use the installed runtime's major-minor
version. A successful response has this shape (result fields vary by method):

```json
{
  "type": "agent.response",
  "response": {
    "id": "req_health_1",
    "ok": true,
    "result": {"daemon": "ok", "extensionConnected": false},
    "error": null,
    "meta": {}
  }
}
```

Failures set `ok: false`, `result: null`, and an `error` object containing
`code`, `message`, optional `details`, and optional `recovery`. Transport loss
or timeout after dispatch does not establish whether a mutation happened.
Inspect postconditions before sending it again; the Go client does not
automatically replay requests.

### Local configuration

`BROWSER_BRIDGE_HOME` overrides the runtime data directory. Defaults are:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/Browser Bridge` |
| Linux | `$XDG_DATA_HOME/browser-bridge`, or `~/.local/share/browser-bridge` |
| Windows | `%LOCALAPPDATA%\Browser Bridge` |

macOS and Linux default to `bridge.sock` inside that directory. Windows defaults
to TCP at `127.0.0.1:9223`; an explicit bridge home without a TCP override uses
an isolated named pipe. `BBX_TCP_PORT` selects TCP; `BBX_TCP_HOST` defaults to
`127.0.0.1`. Agent credentials come from `BBX_AUTH_TOKEN`, `BBX_AUTH_TOKEN_FILE`,
or `daemon.auth` in the bridge home. The native host uses a separate extension
credential. See [remote access](./remote-proxy.md) for configured remote destinations.

## Available methods

The full method list lives in
[`protocol/src/registry.ts`](../protocol/src/registry.ts),
grouped here by domain.

### System

| Method                      | Description                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `access.request`            | Request Browser Bridge access for the focused window. Do not repeat while access is pending       |
| `protocol.describe`         | Return compact method or registry-group parameters and metadata locally                           |
| `skill.get_runtime_context` | Return runtime method groups, budgets, and limits                                                 |
| `setup.get_status`          | Return MCP and skill setup status                                                                 |
| `setup.install`             | Install or uninstall MCP or skill integration targets                                             |
| `log.tail`                  | Tail recent bridge log entries                                                                    |
| `health.ping`               | Check daemon, extension, and access-routing health                                                |
| `daemon.metrics`            | Daemon health and performance metrics                                                             |

### Tabs

| Method          | Description                                       |
| --------------- | ------------------------------------------------- |
| `tabs.list`     | List tabs in the enabled window; optional `limit` and `offset` |
| `tabs.create`   | Create a background tab in the enabled window; `active` defaults to `false` |
| `tabs.close`    | Close a tab in the enabled window                 |
| `tabs.activate` | Bring a tab to the foreground in the enabled window |

Targeting a tab does not activate it. Reads, input, navigation, and screenshots can run in background tabs while the user works elsewhere. Agents may switch to tabs they opened for the current task while the active tab is also in use for that task. They should check active state before switching and track opened tabs from their own `tabs.create` results; `working:true` identifies routing, not ownership or foreground focus. Otherwise, activation requires a user request or permission. If background work needs the tab to be active, the agent should explain why and ask. Permission for one activation does not allow repeatedly taking focus back after the user switches away. These rules apply to `tabs.activate`, `active:true`, and equivalent focus APIs.

### Page

| Method                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `page.get_state`          | Get URL, title, origin, and ready-state for the active page              |
| `page.evaluate`           | Evaluate JavaScript in the page context                                  |
| `page.get_console`        | Read buffered console output from the page                               |
| `page.handle_dialog`      | Inspect or explicitly act on the current JavaScript dialog               |
| `page.wait_for_load_state` | Wait for truthful tab-complete state and/or an event-aware URL condition |
| `page.get_storage`        | Read local or session storage key metadata without values                |
| `page.get_text`           | Read bounded visible text from the page                                  |
| `page.extract_content`    | Extract bounded semantic page content as text or Markdown without returning source HTML |
| `page.get_network`        | Read buffered fetch/XHR activity or explicitly manage bounded all-resource CDP capture |

### Sensitive

| Method           | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `sensitive.read` | Deliberately read one exact local or session storage value |

### Network

| Method                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `network.export_har`      | Export bounded captured network evidence as a HAR 1.2 document, inline or as a daemon-owned artifact |
| `network.intercept.add`   | Add a request interception rule (CDP Fetch domain)                       |
| `network.intercept.remove` | Remove a request interception rule by ID                                |
| `network.intercept.list`  | List active interception rules                                           |
| `network.intercept.clear` | Remove all interception rules and disable interception                   |

Fetch/XHR and console buffers originate in the inspected page's MAIN world.
Their responses include `provenance: "page_main_world"` and
`integrity: "untrusted"`; entries are schema-filtered and bounded, but a page
can still forge telemetry about itself. Request interception accepts at most 32
rules per tab, with a 2,048-character URL pattern, 256 KiB body, 64 headers,
8 KiB per header value, and 64 KiB of headers in total.

### Navigation

| Method                  | Description                          |
| ----------------------- | ------------------------------------ |
| `navigation.navigate`   | Navigate the current tab to a URL    |
| `navigation.reload`     | Reload the current tab               |
| `navigation.go_back`    | Navigate backward in tab history     |
| `navigation.go_forward` | Navigate forward in tab history      |

### DOM

| Method                      | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `dom.query`                 | Query a DOM subtree and return compact node summaries                    |
| `dom.baseline.create`       | Create a short-lived compact semantic DOM baseline for later comparison  |
| `dom.baseline.compare`      | Compare the current DOM with a retained semantic baseline                |
| `dom.baseline.describe`     | Describe a retained semantic DOM baseline and its scope                  |
| `dom.baseline.release`      | Release a retained semantic DOM baseline                                 |
| `dom.describe`              | Describe one element by elementRef                                       |
| `dom.get_text`              | Read bounded text for one element                                        |
| `dom.get_attributes`        | Read selected attributes for one element                                 |
| `dom.wait_for`              | Wait for a selector or text condition in the DOM                         |
| `dom.find_by_text`          | Find elements by visible text                                            |
| `dom.find_by_role`          | Find elements by ARIA role and optional name                             |
| `dom.get_html`              | Read inner or outer HTML for one element                                 |
| `dom.get_accessibility_tree` | Read a depth-limited accessibility tree with optional compact or interactive filtering |

### Layout and styles

| Method                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `layout.get_box_model`    | Read the box model for one element                                       |
| `layout.hit_test`         | Resolve the topmost element at a viewport point                          |
| `styles.get_computed`     | Read requested computed styles; omission returns display, position, width, height, and color |
| `styles.get_matched_rules` | Read element classes and inline style context (not stylesheet cascade data) |

### Viewport

| Method            | Description                              |
| ----------------- | ---------------------------------------- |
| `viewport.scroll` | Scroll the document, an explicit target, or a dominant nested container; ambiguous panels require a target |
| `viewport.resize` | Resize or reset the tab viewport         |

### Input

| Method                  | Description                                                              |
| ----------------------- | ------------------------------------------------------------------------ |
| `input.click`           | Actionability-check and click an element through DOM or optional CDP input; `holdMs` keeps the button pressed |
| `input.focus`           | Actionability-check and focus an element through DOM input               |
| `input.type`            | Actionability-check and type through DOM or optional CDP text input      |
| `input.fill`            | Fill an editable target using a DOM strategy or optional CDP text input; verify afterward |
| `input.press_key`       | Send a key press to the page or an element through DOM or optional CDP input; `holdMs` keeps the key down |
| `input.set_checked`     | Set checkbox or radio checked state                                      |
| `input.select_option`   | Select options in a select element                                       |
| `input.hover`           | Actionability-check and hover through DOM or optional CDP pointer input  |
| `input.drag`            | Actionability-check and drag through DOM or optional CDP pointer input   |
| `input.touch`           | Press 1-10 touch points at the same time (chords, taps, swipes, pinches) |
| `input.perform`         | Run ordered input, wait, and bounded read steps in one call, with optional final evidence |
| `input.scroll_into_view` | Scroll an element into the visible viewport                             |

### Capture

| Method                        | Description                                       |
| ----------------------------- | ------------------------------------------------- |
| `screenshot.capture_region`   | Capture a screenshot of a viewport region         |
| `screenshot.capture_element`  | Capture a screenshot of one element               |
| `screenshot.capture_full_page` | Capture a full-page screenshot beyond the viewport |

### Artifacts

| Method           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `artifact.read`  | Read one bounded chunk from a daemon-owned artifact |
| `artifact.delete` | Delete one daemon-owned artifact              |

### Patch

| Method                          | Description                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `patch.apply_styles`            | Apply a reversible inline style patch                         |
| `patch.apply_dom`               | Apply a reversible DOM patch                                  |
| `patch.list`                    | List active reversible patches                                |
| `patch.rollback`                | Rollback one reversible patch                                 |
| `patch.commit_session_baseline` | Keep current document mutations and discard their rollback history |

### CDP

| Method                          | Description                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `cdp.get_document`              | Read the CDP DOM document tree                               |
| `cdp.get_dom_snapshot`          | Read a CDP DOM snapshot                                      |
| `cdp.get_box_model`             | Read a CDP box model for a node                              |
| `cdp.get_computed_styles_for_node` | Read CDP computed styles for a node                       |
| `cdp.dispatch_key_event`        | Dispatch a key press through Chrome DevTools Protocol input  |

### Performance

| Method                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `performance.get_metrics` | Read a raw Chrome/CDP counter point sample; names and units vary, and BBX measures no navigation window, LCP, CLS, or INP |

## Error codes

| Code                      | Retryable | Meaning                                           |
| ------------------------- | --------- | ------------------------------------------------- |
| `ACCESS_DENIED`           | No        | Browser Bridge is disabled for this window        |
| `EXTENSION_DISCONNECTED`  | Yes (3 s) | Extension not connected to daemon                 |
| `TIMEOUT`                 | Yes (1 s) | Extension did not respond in time                 |
| `CONTENT_SCRIPT_UNAVAILABLE` | No       | Page is restricted or cannot host the content script |
| `DOM_BASELINE_NOT_FOUND`  | No        | Baseline expired, was released/evicted, or does not exist |
| `DOM_BASELINE_INVALIDATED` | No       | Navigation, document, or access scope changed       |
| `DOM_BASELINE_QUOTA_EXCEEDED` | No     | Snapshot or retained-state quota was exceeded       |
| `ARTIFACT_NOT_FOUND`      | No        | Artifact is expired, deleted, missing, or owned by another client |
| `ARTIFACT_QUOTA_EXCEEDED` | No        | Artifact size or owner/global quota is exhausted |
| `ARTIFACT_TRANSFER_INVALID` | No      | Artifact chunk ordering, size, or checksum is invalid |
| `ELEMENT_STALE`           | No        | Element was removed from the DOM                  |
| `ELEMENT_AMBIGUOUS`       | No        | Multiple equally actionable targets matched       |
| `ELEMENT_NOT_ACTIONABLE`  | No        | Target is hidden, disabled, inert, or zero-sized   |
| `ELEMENT_OBSCURED`        | No        | Another element blocks the pointer target          |
| `ELEMENT_NOT_FOUND`       | No        | No element matched the target selector             |
| `INPUT_UNSUPPORTED`       | No        | Execution path does not support the input method   |
| `INPUT_INVALID_TARGET`    | No        | Target/control is incompatible with the input      |
| `INPUT_FOCUS_CHANGED`     | No        | Native text target lost focus before dispatch      |
| `DIALOG_BLOCKED`          | No        | Native dialog blocked an action; inspect before responding or acting again |
| `DIALOG_NOT_OPEN`         | No        | No current dialog is observable                    |
| `DIALOG_ACTION_CONFLICT`  | No        | Dialog observation changed around dispatch         |
| `TAB_MISMATCH`            | No        | Tab closed or not found                           |
| `INVALID_REQUEST`         | No        | Malformed method or params                        |
| `INTERNAL_ERROR`          | Yes (1 s) | Unexpected extension-side error                   |
| `DAEMON_OFFLINE`          | No        | Daemon not running - start with `bbx-daemon`      |
| `CONNECTION_LOST`         | Yes       | Socket dropped mid-request - retry                |
| `BRIDGE_TIMEOUT`          | Yes (1 s) | Extension took too long - retry with simpler call |
| `NATIVE_HOST_UNAVAILABLE` | No        | Run `bbx doctor` to diagnose                      |
| `RESULT_TOO_LARGE`        | No        | Exact sensitive value exceeds the atomic limit    |
| `SENSITIVE_TARGET_NOT_FOUND` | No     | Requested exact storage key does not exist        |

## Interaction contracts

Targeted `input.click`, `focus`, `type`, `fill`, `press_key`, `set_checked`,
`select_option`, `hover`, and `drag` calls return bounded `resolution` metadata
(strategy, candidate counts, scroll/hit-test state, and optional stale recovery)
plus `execution` metadata (requested/actual `dom` or `cdp` path, debugger use,
and coordinates). `cdp.dispatch_key_event`/MCP `cdp_press_key` and
`input.scroll_into_view` have separate response contracts. Explicit refs retain
identity; selectors are ranked only when the first match is not actionable, and
ambiguous or obscured targets fail safely.

`executionMode` accepts `dom` or `cdp` and defaults to `dom`. CDP supports click,
hover, drag, type, fill, press_key, and touch. DOM events follow real device
event order but are untrusted, so gesture-gated features such as audio may need CDP.
`input.perform` runs known multi-step flows inside the extension without a model
round-trip per action. It accepts input and wait steps plus `page.get_state`,
`page.get_text`, `dom.query`, and `dom.get_text`. Set `returnLastResult: true` to
receive the final successful step as `lastResult.result`, bounded to 16384 UTF-8
JSON bytes. Larger results are omitted with `lastResult.truncated: true`; narrow
the read instead of replaying mutations. Sequence actions observe only when
their step requests `observe: true`. Stop at decisions requiring new evidence or
approval, and inspect partial progress after failure before continuing.
See the skill's interaction reference for scheduling with `atMs` and `delayMs`.
This is distinct from `input.fill.mode`, where
`auto`, `setter`, and `keystrokes` choose the DOM fill strategy. Stale recovery
is off by default; `recoverStale: true` is same-document, unchanged-URL, and
requires one strong unique semantic descriptor. Recovery evaluates at most 100
same-tag candidates and returns `ELEMENT_AMBIGUOUS` with
`details.reason: "scan_incomplete"` whenever more candidates exist and
uniqueness cannot be proven.

Input dispatch does not prove an application accepted the intended change.
Verify with a targeted wait or structured read.

## Dialog, URL, AX, and network contracts

- `page.handle_dialog` never auto-accepts or auto-dismisses. `expectedDialogId`
  is a pre-dispatch stale-decision check, not an atomic Chrome binding; inspect
  again after `DIALOG_ACTION_CONFLICT` rather than replaying the mutation.
- `page.wait_for_load_state` supports exact, contains, and restricted-regex URL
  conditions across full and SPA navigation. `waitForLoad` means Chrome tab
  status `complete`, not `networkidle`.
- AX results may filter `compact` or `interactiveOnly` before `maxNodes` and
  always report depth-limited partial-topology metadata. Semantic interactivity
  is not current actionability.
- `page.get_network` defaults to fetch/XHR entries
  `{method,url,status,duration,type,ts,size}` in capture order. `source: "cdp"`
  requires explicit start/read/clear/stop lifecycle, captures broader resource
  metadata, holds debugger ownership while armed, redacts URL secrets, and
  excludes bodies, cookies, authorization values, and complete headers.

### HAR export

`network.export_har` reads only an already armed explicit CDP capture. The
required lifecycle is `page.get_network` start, reproduce, `network.export_har`,
then `page.get_network` stop. Export never starts, stops, or clears capture.

Parameters are `limit` (1-200, default 50), `urlPattern` (substring match
against the sanitized URL), and `delivery` (`auto` default, `inline`, or
`artifact`). The newest matching entries survive the count limit. Inline byte
or token bounds remove complete oldest entries and report `omittedBySize`; HAR
fields are never shortened to fit. `auto` returns an artifact when the complete
bounded document exceeds 256 KiB, while explicit `artifact` always returns an
opaque descriptor. Artifacts expire after five minutes, are owner-scoped to the
client that requested them, and expose no browser-host path. Read them in
bounded chunks with `artifact.read`, verify `byteLength` and `sha256`, then call
`artifact.delete`.

The HAR preserves sanitized scheme/host/path and query names, with credentials,
fragments, and query values removed. It has no request/response headers,
cookies, bodies, or authorization data. Unsupported header/body/content sizes
and send/wait/receive phases are `-1`; `entry.time` is the observed total
duration. Redirects are emitted as observed entries, while failures and cache,
disk-cache, prefetch-cache, and service-worker observations appear in `_bbx`.
Result metadata reports `dropped` retained-buffer loss, `abandoned` unfinished
activity discarded by capture lifecycle/bounds, and currently unfinished
`inflight` requests, which are not HAR entries.

### Recovery telemetry

Recovery summaries are process-local five-minute windows built from fixed
five-second buckets. Three failures in the same internal group within 60 seconds
set the category and summary `activeLoop` flags. Public output contains only the
six fixed categories `automatic_mcp_retry`, `stale_ref_recovery`,
`debugger_reattach`, `content_script_reinjection`, `native_host_reconnect`, and
`request_outcome`, with counts, rates, timestamps, saturation, and loop flags.
It contains no page data, URLs, selectors, payloads, errors, or internal group
names.

`health.ping` with `diagnostics: true` returns daemon and, when routed, extension summaries;
`daemon.metrics` returns the daemon summary. `bbx doctor` combines them and adds
fixed category-specific guidance for active loops. Stop repeated attempts and
follow that guidance rather than feeding the loop. Extension telemetry resets
when the service worker restarts; daemon telemetry resets when the daemon
restarts.

Routine `health.ping` calls omit build identity, debugger/capture status, DOM
baseline metrics, transport/proxy details, and recovery telemetry. Connectivity,
version compatibility fields, access readiness, and `connectedExtensions` remain
available. Use `bbx call health.ping '{"diagnostics":true}'` for the full report,
or pass `diagnostics: true` to MCP `browser_health`.

### Performance metrics

`performance.get_metrics` returns `{metrics, measurement}` from CDP
`Performance.getMetrics`. It is a browser-maintained point sample whose names,
availability, and units vary by Chrome version. Browser Bridge establishes no
navigation observation window and does not measure LCP, CLS, or INP; do not
interpret these counters as Web Vitals or page-load measurements.

## One-off calls

Each CLI invocation opens and closes its own transport connection:

```bash
bbx call --extension '<connection ID>' --tab 123 page.get_state '{}'
```

MCP keeps an agent connection for the process lifetime. Owner-scoped resources
such as artifacts need that same connection for follow-up reads. CLI helpers
such as `bbx screenshot` and `bbx har` perform capture, download, verification,
and deletion in one process.

# BridgeClient API Reference

`BridgeClient` is the programmatic interface for agents and tools that want to
communicate with the Browser Bridge daemon directly, without going through the
CLI or MCP server.

If you are setting up Browser Bridge for normal end-user agent usage, start with
[quickstart](./quickstart.md) or [manual setup](./manual-setup.md) instead.

## Install

```bash
npm install @browserbridge/bbx
```

## Quick start

```js
import { BridgeClient } from '@browserbridge/bbx/packages/agent-client/src/client.js';

const client = new BridgeClient();
await client.connect();

const response = await client.request({ method: 'health.ping' });
console.log(response.result); // { daemon: 'ok', extensionConnected: true, ... }

await client.close();
```

## Constructor

```js
new BridgeClient(options?)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `socketPath` | `string` | `~/.config/browser-bridge/bridge.sock` | Optional bridge socket path override when not using `BBX_TCP_PORT` |
| `clientId` | `string` | `agent_<uuid>` | Identifies this client to the daemon |
| `defaultTimeoutMs` | `number` | `8000` | Per-request timeout in ms |
| `autoReconnect` | `boolean` | `false` | Reconnect automatically after daemon restarts and emit `reconnected` when the session is restored |
| `checkProtocolOnConnect` | `boolean` | `true` | Run the protocol health preflight during connection |
| `updateNpmOnCompatibleVersion` | `boolean` | `false` | Update a verified global npm installation to the highest stable release supported by the connected extension |

When `BBX_TCP_PORT` is set, `BridgeClient` connects to `127.0.0.1:<port>` instead of the Unix socket path.

## Methods

### `connect()`

Connect to the daemon and register as an agent. Performs a `health.ping` to
establish protocol compatibility. Throws if the daemon is not running.

```js
await client.connect();
```

### `request(options)`

Send a bridge request and return the response.

```js
const response = await client.request({
  method: 'dom.query',
  params: { selector: 'h1', maxNodes: 5 },
  tabId: 123, // optional - omit to route to the active tab in the enabled window
  timeoutMs: 10_000, // optional - overrides defaultTimeoutMs
});

if (response.ok) {
  console.log(response.result);
} else {
  console.error(response.error.code, response.error.message);
}
```

**Returns** a `BridgeResponse`:

```ts
{ id, ok: true, result: unknown, error: null, meta }
| { id, ok: false, result: null, error: { code, message, details, recovery? }, meta }
```

When `ok` is `false`, `error.recovery` (if present) contains machine-readable
retry guidance:

```js
if (!response.ok && response.error.recovery?.retry) {
  await new Promise((r) => setTimeout(r, response.error.recovery.retryAfterMs ?? 1000));
  // retry once
}
```

### `close()`

Gracefully close the connection (sends TCP FIN, waits for acknowledgement).

```js
await client.close();
```

### `reconnected` event

When `autoReconnect: true` is enabled, `BridgeClient` emits `reconnected` after
the socket is re-established and the agent is registered again.

```js
client.on('reconnected', () => {
  console.log('Browser Bridge reconnected');
});
```

## Available methods

See [`packages/protocol/src/registry.js`](../packages/protocol/src/registry.js) for the full list. Common ones:

| Method                       | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `access.request`             | Request window access (surfaces Enable prompt) |
| `health.ping`                | Check daemon and extension connectivity        |
| `tabs.list`                  | List tabs in the enabled window                |
| `page.get_state`             | URL, title, readyState of the active tab       |
| `dom.query`                  | Query DOM subtree with CSS selector            |
| `dom.baseline.create`        | Retain a short-lived memory-only semantic snapshot |
| `dom.baseline.compare`       | Return exact bounded semantic changes from a baseline |
| `dom.baseline.describe`      | Read baseline scope, expiry, options, and counts |
| `dom.baseline.release`       | Idempotently release a retained baseline       |
| `dom.find_by_text`           | Find elements by visible text                  |
| `page.evaluate`              | Run JavaScript in the page context             |
| `page.get_console`           | Read buffered console output                   |
| `page.get_storage`           | Read bounded storage key/presence metadata     |
| `sensitive.read`             | Deliberately read one exact storage value      |
| `page.handle_dialog`         | Inspect or explicitly handle current JS dialog |
| `page.wait_for_load_state`   | Wait for tab complete and/or URL condition      |
| `page.get_network`           | Fetch/XHR or explicit CDP resource capture      |
| `network.export_har`         | Export armed CDP evidence as metadata-only HAR 1.2 |
| `performance.get_metrics`    | Raw browser-maintained CDP counter point sample |
| `dom.get_accessibility_tree` | Depth-limited compact/interactive AX data       |
| `input.click`                | Actionability-aware DOM or CDP click            |
| `input.type`                 | Actionability-aware DOM or CDP text input       |
| `cdp.dispatch_key_event`     | Dispatch keyDown/keyUp through CDP input       |
| `navigation.navigate`        | Navigate to a URL                              |
| `screenshot.capture_element` | Complete PNG/JPEG/WebP element capture with inline, auto, or artifact delivery |
| `artifact.read`              | Read a bounded chunk from an owner-scoped artifact |
| `artifact.delete`            | Delete an owner-scoped artifact                 |
| `patch.apply_styles`         | Apply reversible CSS overrides                 |

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
hover, drag, type, and fill. This is distinct from `input.fill.mode`, where
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

`health.ping` returns daemon and, when routed, extension summaries;
`daemon.metrics` returns the daemon summary. `bbx doctor` combines them and adds
fixed category-specific guidance for active loops. Stop repeated attempts and
follow that guidance rather than feeding the loop. Extension telemetry resets
when the service worker restarts; daemon telemetry resets when the daemon
restarts.

### Performance metrics

`performance.get_metrics` returns `{metrics, measurement}` from CDP
`Performance.getMetrics`. It is a browser-maintained point sample whose names,
availability, and units vary by Chrome version. Browser Bridge establishes no
navigation observation window and does not measure LCP, CLS, or INP; do not
interpret these counters as Web Vitals or page-load measurements.

## Using `withBridgeClient`

For one-off calls, `withBridgeClient` handles connect/close automatically:

```js
import { withBridgeClient } from '@browserbridge/bbx/packages/agent-client/src/runtime.js';

const result = await withBridgeClient(async (client) => {
  return client.request({ method: 'page.get_state' });
});
```

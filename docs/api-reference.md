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
  tabId: 123, // optional - required for tab-bound methods
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
| `dom.find_by_text`           | Find elements by visible text                  |
| `page.evaluate`              | Run JavaScript in the page context             |
| `page.get_console`           | Read buffered console output                   |
| `page.get_network`           | Read intercepted fetch/XHR requests            |
| `input.click`                | Click an element                               |
| `input.type`                 | Type text into an element                      |
| `cdp.dispatch_key_event`     | Dispatch keyDown/keyUp through CDP input       |
| `navigation.navigate`        | Navigate to a URL                              |
| `screenshot.capture_element` | Capture element as PNG (base64)                |
| `patch.apply_styles`         | Apply reversible CSS overrides                 |

## Error codes

| Code                      | Retryable | Meaning                                           |
| ------------------------- | --------- | ------------------------------------------------- |
| `ACCESS_DENIED`           | No        | Browser Bridge is disabled for this window        |
| `EXTENSION_DISCONNECTED`  | Yes (3 s) | Extension not connected to daemon                 |
| `TIMEOUT`                 | Yes (1 s) | Extension did not respond in time                 |
| `RATE_LIMITED`            | Yes (2 s) | Too many concurrent requests                      |
| `ELEMENT_STALE`           | No        | Element was removed from the DOM                  |
| `TAB_MISMATCH`            | No        | Tab closed or not found                           |
| `INVALID_REQUEST`         | No        | Malformed method or params                        |
| `INTERNAL_ERROR`          | Yes (1 s) | Unexpected extension-side error                   |
| `DAEMON_OFFLINE`          | No        | Daemon not running — start with `bbx-daemon`      |
| `CONNECTION_LOST`         | Yes       | Socket dropped mid-request — retry                |
| `BRIDGE_TIMEOUT`          | Yes (1 s) | Extension took too long — retry with simpler call |
| `NATIVE_HOST_UNAVAILABLE` | No        | Run `bbx doctor` to diagnose                      |

## Using `withBridgeClient`

For one-off calls, `withBridgeClient` handles connect/close automatically:

```js
import { withBridgeClient } from '@browserbridge/bbx/packages/agent-client/src/runtime.js';

const result = await withBridgeClient(async (client) => {
  return client.request({ method: 'page.get_state' });
});
```

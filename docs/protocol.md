# Protocol Negotiation

Browser Bridge uses a lightweight version negotiation mechanism to detect
mismatched versions between the agent client (CLI/MCP) and the daemon.

## Current version

The protocol version is defined in `packages/protocol/src/protocol.js`:

```js
export const PROTOCOL_VERSION = '1.0';
export const SUPPORTED_VERSIONS = Object.freeze(['1.0']);
```

Both the client and daemon import `PROTOCOL_VERSION` from the same shared
`@browserbridge/protocol` package, so matched installations always agree.

## When negotiation happens

Protocol negotiation occurs during `BridgeClient.connect()`. After the TCP/Unix
socket is established and the agent registration handshake completes, the client
sends a `health.ping` request with its protocol version embedded in
`meta.protocol_version`:

```json
{
  "type": "agent.request",
  "request": {
    "id": "req_abc123",
    "method": "health.ping",
    "params": {},
    "meta": {
      "protocol_version": "1.0",
      "token_budget": null
    }
  }
}
```

## How the daemon responds

The daemon compares the client's `protocol_version` against `SUPPORTED_VERSIONS`
using `getVersionNegotiationPayload()` in
`packages/native-host/src/daemon.js:84`.

### Version matches

When the client version is in `SUPPORTED_VERSIONS`, the response includes only
the supported versions list:

```json
{
  "ok": true,
  "result": {
    "daemon": "ok",
    "extensionConnected": true,
    "supported_versions": ["1.0"]
  }
}
```

No `migration_hint` or `deprecated_since` fields are present.

### Client is newer (daemon outdated)

When the client version is newer than any version the daemon supports
(e.g., client sends `99.0` but daemon only knows `1.0`):

```json
{
  "ok": true,
  "result": {
    "daemon": "ok",
    "supported_versions": ["1.0"],
    "migration_hint": "Browser Bridge daemon is older than the client protocol 99.0. Restart or update the Browser Bridge CLI so the daemon supports 99.0."
  }
}
```

This means the daemon process was started from an older installation. Restarting
the daemon (or updating the npm package and restarting) resolves it.

### Client is older (daemon newer)

When the client version is older than the daemon's latest supported version
(e.g., client sends `0.5` but daemon supports `1.0`):

```json
{
  "ok": true,
  "result": {
    "daemon": "ok",
    "supported_versions": ["1.0"],
    "deprecated_since": "1.0",
    "migration_hint": "Browser Bridge daemon is newer than the client protocol 0.5. Restart or update the Browser Bridge CLI/npm package to 1.0 or later."
  }
}
```

The `deprecated_since` field indicates the version at which the client's version
was superseded. Update the client npm package to resolve this.

## Client-side handling

`BridgeClient.connect()` (in `packages/agent-client/src/client.js:104`) calls
`health.ping` automatically and runs the result through
`BridgeClient.checkProtocolVersion()`:

- If the client's version is not in the daemon's `supported_versions` list, the
  client sets `this.protocolCompatibility.compatible = false` and stores a
  warning string.
- All subsequent responses via `client.request()` have
  `meta.protocol_warning` attached when a version mismatch exists.
- The `connect()` call itself does **not** throw on version mismatch — the
  client remains usable, but callers should check `client.protocolWarning` or
  `client.protocolCompatibility` after connecting.

```js
const client = new BridgeClient();
await client.connect();

if (client.protocolWarning) {
  console.warn('Protocol version mismatch:', client.protocolWarning);
}
```

## Wire format summary

| Scenario | `supported_versions` | `deprecated_since` | `migration_hint` |
|---|---|---|---|
| Versions match | `["1.0"]` | absent | absent |
| Client newer | `["1.0"]` | absent | "daemon is older..." |
| Client older | `["1.0"]` | `"1.0"` | "daemon is newer..." |

## Version comparison

Versions are compared as dot-separated numeric sequences
(`compareProtocolVersions` in `daemon.js:67`). This allows future versions like
`1.1` or `2.0` to be ordered correctly without tight coupling to semver.

## Adding a new protocol version

1. Update `PROTOCOL_VERSION` and prepend the new version to
   `SUPPORTED_VERSIONS` in `packages/protocol/src/protocol.js`.
2. Publish the updated `@browserbridge/protocol` package.
3. The daemon automatically advertises the new version. Clients that still send
   the old version will receive a `deprecated_since` hint pointing them to
   upgrade.

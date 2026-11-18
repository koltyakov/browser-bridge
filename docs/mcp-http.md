# Optional daemon-hosted MCP HTTP

BBX can serve MCP from an authenticated, loopback-only HTTP listener inside its
existing daemon. Multiple clients use that process instead of launching separate
`bbx mcp serve` subprocesses. Browser native-messaging hosts remain separate.

HTTP is disabled by default. Managed MCP installations continue to use the
absolute Go executable with `mcp serve`. This feature does not change agent
configuration, enable browser access, or replace the native bridge transport.

## Configure the daemon

Place `mcp-http.json` in the bridge home:

- macOS: `~/Library/Application Support/Browser Bridge`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/browser-bridge`
- Windows: `%LOCALAPPDATA%\Browser Bridge`
- An explicit `BROWSER_BRIDGE_HOME` overrides these defaults.

Example for macOS, replacing `/Users/you` with your home directory:

```json
{
  "enabled": true,
  "listen": "127.0.0.1:9224",
  "clients": {
    "opencode": "/Users/you/Library/Application Support/Browser Bridge/opencode-http.token"
  },
  "idleTimeoutSeconds": 1800,
  "maxLifetimeSeconds": 86400
}
```

Each client entry names an absolute credential-file path. Use a different token
for each integration. Tokens must contain 32 to 256 ASCII letters, digits, `_`, or
`-`. Do not use `daemon.auth` or `daemon.extension.auth`, or copies of their tokens.
On macOS and Linux the file must be a regular file with no group/other permissions.
On Windows restrict its ACL to the intended user.

For example, on macOS or Linux, generate a token in an existing private directory:

```sh
umask 077
openssl rand -hex 32 | tr -d '\n' > "/absolute/private/directory/opencode-http.token"
```

The example deliberately omits a trailing newline so it can also be used in an
HTTP header through a client's file-content substitution.

Only literal loopback IP listen addresses are accepted, including IPv6 `::1`.
The default address is `127.0.0.1:9224`. Port `0` requests an ephemeral port,
reported in endpoint status, but a fixed port is easier to configure in clients.
The existing raw TCP proxy is not an MCP HTTP endpoint.

## Start and inspect

The daemon reads this configuration at startup. If no daemon is running, start
`bbx-daemon`; Chrome does not have to launch it first. If one is already running,
activate a configuration change with an explicit `bbx restart` at an appropriate
time. Restarting interrupts existing calls and connections; it is not necessary
merely to inspect configuration.

```sh
bbx mcp http-status
```

This command reads the private `mcp-http-status.json` registration without
starting or restarting anything. The recorded status contains a PID, URL or
startup error, and timestamp, never a token. It is not a live endpoint probe.
The registration is removed on normal daemon shutdown.

A bad HTTP configuration, invalid credentials, or occupied HTTP port leaves the
native bridge and stdio available. It reports an error instead of binding another
interface. Settings and client-file mappings require daemon restart; changing or
removing the contents of an already configured credential file does not.

## Configure a client explicitly

Clients need Streamable HTTP support and the matching protocol revision. Keep
stdio for clients that do not support it. No automatic installer migration is
performed.

For OpenCode V2, merge the following server entry into its configuration, using
your actual token-file path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "browser-bridge": {
        "type": "remote",
        "url": "http://127.0.0.1:9224/mcp",
        "oauth": false,
        "headers": {
          "Authorization": "Bearer {file:/absolute/private/directory/opencode-http.token}"
        },
        "protocol": "auto",
        "pool": true
      }
    }
  }
}
```

The token file must contain just the token without a newline for this header
example. Environment-variable substitution is another option, provided the
variable is available to the OpenCode service, not just a project's shell.
`pool` reduces OpenCode's logical connections; HTTP itself eliminates BBX MCP
subprocesses whether or not a client pools.

To fall back, explicitly restore the original local server entry with its
absolute executable and `["mcp", "serve"]` arguments. Never replay an uncertain
browser action merely because another transport is available.

## Protocol compatibility

The same `/mcp` endpoint supports:

- Legacy Streamable HTTP revisions `2025-03-26`, `2025-06-18`, and `2025-11-25`,
  with initialization, credential-bound session IDs, POST messages, a GET SSE
  notification stream, and DELETE session termination. Progressive tool loading
  and tool-list notifications remain session-local. Only one GET stream per
  legacy session is accepted.
- Modern `2026-07-28`, with per-request metadata, validated
  `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` headers,
  fixed tools, and POST SSE subscription streams. No protocol session is minted.
  GET and DELETE are not modern transports.

POST requires `Content-Type: application/json` and an `Accept` header containing
both `application/json` and `text/event-stream`. Modern tool calls return a
request-scoped SSE response; other simple results can return JSON.

Deprecated 2024 HTTP+SSE is not implemented; its stdio counterpart remains
supported. HTTP stream replay is not provided. Unsupported modern versions,
header/body mismatches, and missing or expired legacy sessions return explicit
errors before browser dispatch.

## Ownership, cancellation, and cleanup

Legacy sessions have distinct resource owners, even when initialized with the
same credential. A session ID is not authentication; the original credential is
required on every request.

Modern requests using the same credential share one application-resource owner
within a daemon instance and owner lease. This is deliberate because modern MCP
has no protocol sessions. Separate credentials are the client-isolation boundary.
Reusing a credential from another application also shares that ownership domain.

OpenCode's request-local session metadata continues to partition conversation
routing and session-scoped resources. It is not authentication. Artifacts remain
transport-owned, so conversations on one owner can use a known artifact ID.
Neither HTTP connection identity nor self-reported client names grant access.

Legacy work survives an HTTP disconnect until explicit MCP cancellation, its
deadline, or owner shutdown. Closing a modern tool's SSE response cancels that
request. Cancellation propagates to the native bridge but does not undo browser
effects. Mutations are never automatically replayed.

Owners expire after 30 minutes without activity or 24 hours of lifetime by
default. In-flight calls pin them until completion, but owners past their maximum
lifetime stop accepting new calls while existing work drains. Quiet subscriptions and
server heartbeats do not prevent expiry. Expired owners do not recover their
handles on the next request. Token replacement or deletion is checked on every
authentication attempt; existing owners are revoked by a one-second sweep.
An already-running client must reload its own credential to use a replacement.

Expiry, revocation, DELETE, and shutdown close the owner's bridge connections
and run existing owner cleanup, including artifact cleanup and browser
owner-disconnected notifications. Existing browser access settings remain in
force. HTTP project-local setup/status without a project directory is rejected;
run project-local setup with the CLI from the intended directory.

The server bounds JSON messages to 1 MiB, owners to 64, tool calls to 16 per
owner, active HTTP handlers to 128, and notification streams to 64 globally and
16 per owner. Tool deadlines remain 124 seconds. Headers, request reads, response
writes, notification queues, and idle connections are also bounded.

Host and Origin are validated, query-string credentials are rejected, and no
permissive CORS headers are emitted. Non-loopback service, TLS termination,
OAuth server support, and automatic client migration are outside this feature.

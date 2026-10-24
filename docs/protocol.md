# Protocol Compatibility

The Go CLI, daemon, native host, and MCP server use the shared wire definitions
in [`protocol/types.ts`](../protocol/types.ts). The extension and build tooling
use shared metadata and helpers under `protocol/src/`. MCP tool schemas and
instructions live in `protocol/mcp-tools.json`.

## Versions

The Go runtime derives its protocol version from the built executable's
major-minor version (`protocolVersion()` in `internal/bridge/client.go`).
The extension derives its version from its manifest through the shared
protocol helpers.

Compatibility requires the same major version. Extension and npm minor and
patch releases advance independently: an extension advertising `1.11` and
a client advertising `1.12` are compatible in either direction.
`make check-release-version` checks the major version; tests also enforce
that the npm package and lockfile versions match.

## Requests and health

The Go client registers an authenticated agent connection, then sends requests
with `meta.protocol_version`. Registration itself does not perform a health
preflight. Inspect health explicitly when checking compatibility:

```bash
bbx call health.ping '{}'
bbx doctor
```

A wire request looks like this; the version is illustrative:

```json
{
  "type": "agent.request",
  "request": {
    "id": "req_health_1",
    "method": "health.ping",
    "params": {},
    "tab_id": null,
    "meta": {
      "protocol_version": "1.14",
      "token_budget": null
    }
  }
}
```

Health reports the daemon's `daemonVersion`, `daemon_supported_versions`, and
`supported_versions`. When a routed extension responds, it also reports
`extensionVersion` and `extension_supported_versions`. `connectedExtensions`
identifies the available browser/profile connections. See the
[wire API reference](./api-reference.md) for registration and response envelopes.

`health.ping` is compact by default. Use `bbx call health.ping '{"diagnostics":true}'`
for build identity, debugger/capture status, DOM baseline metrics, transport/proxy
details, and recovery telemetry. Doctor requests these details automatically.

Doctor compares the client's major version with the daemon and extension
version lists and reports compatibility. A successful transport connection or
`ok: true` health response alone does not establish version compatibility.
Use Doctor's `protocol` diagnostics for the compatibility result.

## Updating a mismatched installation

For npm installations, npm owns the runtime version:

```bash
npm install -g @browserbridge/bbx@latest
bbx restart
bbx doctor
```

The npm launcher downloads the exact package version's Go executable and
verifies its pinned digest. `bbx update status` reports `distribution: "npm"`;
native self-update does not replace npm's selected runtime.

Separately installed native executables can use a configured signed update
feed. With `auto-update` set to `compatible`, a local health check may trigger
an update before CLI browser work or MCP startup. It selects a compatible
release using the extension's advertised protocol versions. Remote
destinations do not update the local installation, and browser actions are
not replayed after an update. See [native runtime](../internal/bridge/README.md)
for signed update configuration.

## Changing the protocol

1. Change canonical wire types in `protocol/types.ts`, method metadata in
   `protocol/src/`, or MCP metadata in `protocol/mcp-tools.json` as appropriate.
2. Run `make generate-protocol` and `make check-protocol`. Commit generated Go
   bindings, schemas, runtime catalog, and embedded skills with their sources.
3. Add Go runtime tests and shared fixture or TypeScript extension/integration
   tests for the changed behavior.
4. For breaking wire changes, coordinate the package and extension major
   versions and publish compatible artifacts.

Go source and tests own runtime behavior. TypeScript tests cover browser code,
shared protocol helpers, npm packaging, and real-process wire integration.

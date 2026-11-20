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

A same-major minor mismatch does not disable the extension, native host, or
browser access. When the extension is on a newer minor line, the side panel
shows a dismissible update recommendation while normal work continues. A newer
native minor or a patch-only difference does not require a binary upgrade.

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
Diagnostic health also reports `nativeUpdateSupported`. A value of `true`
advertises the feed-free `bbx update` command. The side panel recommends
`bbx update`, followed by `bbx restart`, only when that capability is explicitly
present. For older hosts that omit it or report `false`, it recommends the
platform-specific native installer script from Host Setup instead. A version
number alone is not evidence of a configured updater.

Native identity can advertise `extensionUpdateChecks: true` and the installed
`extensionVersion`. The daemon compares versions only within the same
`browserExtensionId`, and exposes observed versions in `connectedExtensions`.
Capable older peers receive a bounded `host.update_check` signal through the
native relay. Available store updates use `host.update_ready` /
`host.update_cancel` and `host.update_apply` to drain outstanding requests before
reload. These lifecycle signals do not enable page access or replay commands.
Diagnostic health advertises `extensionUpdateSupported` for this coordination.

Doctor compares the client's major version with the daemon and extension
version lists and reports compatibility. A successful transport connection or
`ok: true` health response alone does not establish version compatibility.
Use Doctor's `protocol` diagnostics for the compatibility result.

## Updating a mismatched installation

To manually refresh an npm installation:

```bash
npm install -g @browserbridge/bbx@latest
bbx restart
bbx doctor
```

The npm launcher downloads a stable GitHub release independently of its package
version and verifies its release checksum. Set `BBX_VERSION` during installation
to select the extension's release line or an exact native version.

Binaries with the GitHub updater automatically select the latest stable patch
in the newest installed extension's `major.minor` release line, on extension
reconnect and periodic checks. No separate feed is used. Standalone installs
follow the same policy.

Older unconfigured binaries need a one-time native upgrade; updating the extension
cannot add this support. See [migration requirements](./native-cli.md#one-time-upgrade-for-unconfigured-installations).

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

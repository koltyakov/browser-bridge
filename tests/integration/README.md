# Go process integration coverage

These tests run the Go executable, a JSON-lines test peer, or the MCP SDK client
over stdio. Test helpers contain framing, fixtures, and process cleanup only.
They do not implement the former JavaScript runtime.

Build `dist/cli/bbx` with `make build-native` before running these tests, or set
`BBX_NATIVE_EXECUTABLE` to a built executable. The executable's version must match
`package.json` because protocol-major compatibility is enforced on the wire.

```sh
node --import tsx --test tests/integration/*.test.ts
```

## Migration coverage map

The former `packages/integration-tests/` suites map to these checks:

| Former suite | Coverage now |
| --- | --- |
| `cli-batch.test.ts` | `cli-batch.test.ts`: ordered concurrent reads, isolated failures, mutation rejection before dispatch, malformed JSON. |
| `mcp.test.ts` | `mcp.test.ts`: real Go MCP subprocesses with the official SDK; legacy and modern negotiation, concurrent connection-owned file handles, cancellation, reconnect invalidation, disconnect cleanup, investigation budgets, exact tool enablement and notifications. |
| `network-intercept.test.ts` | `network-intercept.test.ts`: add/list/remove/clear and error forwarding through the Go daemon. |
| `webmcp.test.ts` | `webmcp.test.ts`: full schema and result JSON, explicit tab routing, approval rejection, approved execution. |
| `round-trip.test.ts` | `daemon-wire.test.ts`: CLI DOM budgets, health merging, disconnect errors, pending-request cleanup. Error payloads and ordinary request/response round trips also remain in the intercept and WebMCP suites. `internal/bridge/mcp_test.go` covers cancellation and retry boundaries. |
| `daemon-restart.test.ts` | `daemon-wire.test.ts`: killed process rejects pending work, same-port restart accepts new connections, extension disconnect clears metrics. MCP reconnection uses the Go MCP process in `mcp.test.ts`. The removed Node client's reconnect event and backoff API no longer exist. |
| `protocol-version.test.ts` | `daemon-wire.test.ts`: current and future same-major versions succeed; incompatible older and newer majors fail. The Go runtime enforces protocol majors instead of accepting arbitrary versions with migration hints. |
| `stale-socket.test.ts` | `local-transport.test.ts`: a real stale socket left by a killed daemon is rebound. A regular file is preserved and rejected, replacing the unsafe old placeholder-file behavior. |
| `windows-pipe.test.ts` | `local-transport.test.ts` runs the isolated-home named-pipe path on Windows, including crash recovery. String classification and Node constructor assertions were implementation-only tests. |
| `artifact.test.ts` | `internal/bridge/artifact_test.go`: bounded multi-chunk readback, ownership, deletion, expiry, forged and uncommitted transfers. `tests/native/daemon-services.test.ts` also exercises these through Go daemon/native-host processes. |
| `dom-baseline.test.ts` | `internal/bridge/baseline_test.go`: cross-client routing, unknown releases, extension disconnect, expiry, forged ownership and orphan cleanup. `tests/native/daemon-services.test.ts` retains the process-level baseline capability checks. |
| `har-export.test.ts` | `har-export.test.ts` retains invalid-HAR output rejection. HAR bytes use the same artifact transfer path tested by `TestArtifactDaemonWireRoundTrip`, `TestArtifactDaemonRoutingAndForgedTransfers`, and the native daemon-services suite. CLI artifact checksum and cleanup are covered by `TestCLIArtifactIntegrityAndCleanup`. |
| `happy-path.test.ts` | `tests/native/native.test.ts`: Go native host relays fragmented Chrome frames through the Go daemon; profile routing and mid-flight disconnects. `internal/bridge/wire_test.go` covers oversized and truncated frames. `local-transport.test.ts` covers crash recovery. Node-only `protocol_warning` response decoration is retired with that client API. |

DOM budget assertions normalize the received request with the same shared helper
used by the extension. Go may send flat limits or a nested `budget`; both forms
must preserve the requested values.

The shared test helpers are `runCli.ts`, `socketHarness.ts`, `daemonHarness.ts`,
and `nativeWire.ts`.

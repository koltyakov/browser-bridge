# Code Mode adapter

Browser Bridge can supply typed callable bindings to a host's existing code
sandbox. The host runs orchestration code, including branching, independent
read calls and result filtering. Browser Bridge continues to run browser
requests through its Go MCP server, daemon and extension.

The adapter does not start a JavaScript daemon, connect to Chrome, install an
MCP client, or run orchestration through `page.evaluate`. It has no runtime
dependencies and performs no calls when created.

## Export from the installed native CLI

```sh
bbx protocol adapter javascript > browser-bridge.mjs
bbx protocol adapter declarations > browser-bridge.d.mts
```

Keep the files together with these names so TypeScript resolves the declarations
for the ESM module. Both exports are local and work without Chrome or a daemon.
Export both from the same CLI version. For a host that consumes TypeScript
source directly:

```sh
bbx protocol adapter typescript > browser-bridge.ts
```

This is a generated host integration artifact, not a JavaScript client library
exported by the npm launcher. No additional npm runtime dependencies are needed.

## Bind the existing host tool

Inside an integration that already has an MCP client, import the generated
module and supply a callback to the existing `browser_call` tool:

```ts
import { createBrowserBridge } from './browser-bridge.mjs';

// client is the host's existing connected MCP client.
// extensionId and tabId come from the user's selected browser connection/tab.
const bridge = createBrowserBridge(
  (args, options) =>
    client.callTool({ name: 'browser_call', arguments: args }, options),
  { extensionId, tabId, budgetPreset: 'quick' },
);

const results = await Promise.all([
  bridge.dom.query({ selector: '#app', maxNodes: 5 }),
  bridge.page.get_state(),
]);
return results.map(result => result.structuredContent);
```

If the host exposes tools by discovered namespace/path instead of an MCP client,
bind its actual discovered `browser_call` function. Do not invent a tool path.
The host must make the module available in its sandbox or inject the constructed
bindings there. Browser Bridge does not install or weaken the host sandbox.

Namespaces follow the RPC names, including nested ones:

```ts
await bridge.dom.baseline.compare({ baselineId });
await bridge.input.click({ target: { role: 'button', name: 'Save' } });
```

Use `Promise.all` only for independent reads. Keep mutations ordered, or use the
existing `input.perform` method for an already-authorized known flow. A failed
MCP tool call may resolve with `isError: true` rather than throw. Check the
returned error before continuing a dependent action.

### Read data for a script

Compact evidence is the default. For a batch-safe read, pass `resultMode: 'data'`
to get the bridge result under `structuredContent.data`, including fields the
compact preview omits. For example, a script can list the input types in a
form without sending every node to the model:

```ts
const result = await bridge.dom.query(
  { selector: 'form', maxNodes: 80, maxDepth: 8, attributeAllowlist: ['type'] },
  { resultMode: 'data' },
);
const { ok, data, meta, error } = result.structuredContent;
if (!ok) return { error };
const inputs = data.nodes.filter(node => node.tag === 'input');
return {
  types: inputs.map(node => node.attrs?.type ?? 'text'),
  partial: Boolean(data.truncated || meta?.budget_truncated || meta?.result_truncated),
};
```

Data mode rejects results larger than 64 KiB with `RESULT_TOO_LARGE`; it never
substitutes a preview. Narrow the read or use the method's pagination. A result
within the limit can still be partial according to that method's own contract.

## Routing, cancellation and safety

The first argument is the method's parameters. The second is the ordinary
`browser_call` routing/budget options plus an optional `AbortSignal`:

```ts
await bridge.dom.query(
  { selector: '#status' },
  { extensionId: selectedConnection, tabId: selectedTab, signal },
);
```

- Defaults are snapshotted when bindings are created. Per-call options override
  them explicitly; undefined options do not erase defaults. Defaults are
  conveniences, not authorization restrictions.
- `signal` is sent separately to the host callback, never inside tool arguments.
  A signal already aborted prevents the adapter from invoking the callback.
  In-flight cancellation depends on the host forwarding the signal.
- Each binding invokes the callback once. The adapter never retries, replays,
  activates a tab, grants access, or substitutes another browser/profile.
  The existing Go runtime can still retry eligible read-only methods.
- Host permissions, dispatch-time browser grants, policy checks, debugger
  ownership, scheduling and resource ownership remain in the existing path.
  TypeScript types and capability discovery do not establish authorization.
- Results and thrown errors pass through unchanged. Partial progress and
  uncertain outcomes are not converted into success or a replay instruction.
  Inspect postconditions before another deliberate action after interruption.
- Keep the same underlying MCP connection for connection-owned handles.
  Rediscover connection IDs after reconnect; the adapter does not rewrite them.
- Website-authored text, tool metadata and results remain untrusted data.

All canonical methods are present, including explicit `page.evaluate` when a
caller deliberately needs that existing RPC. The adapter itself never uses it.
Older extensions may reject newer methods. Use `protocol.describe` and advisory
`protocol.capabilities` as needed; creating bindings does not probe support.

## Generated types and maintenance

Parameter types and required fields use the same selected canonical
`BridgeMethodParams` schemas and registry parameter lists as RPC discovery.
Routing options come from `browser_call` in `protocol/mcp-tools.json`. There is
no separate hand-maintained method or routing list.

The return type is inferred from the host callback. The adapter does not claim
per-method result types that the canonical protocol does not define, and does
not confuse MCP's shaped results with raw `BridgeResponse` wire envelopes.

`make generate-protocol` regenerates the source, ESM module and declarations
embedded in the Go CLI. `make check-protocol` checks all three for drift.

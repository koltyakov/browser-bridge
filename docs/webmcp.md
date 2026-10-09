# WebMCP in Browser Bridge

BBX can discover and execute tools a website exposes through the current `document.modelContext` WebMCP API. The agent still connects to BBX through MCP or the CLI. No additional MCP server or website credentials are needed.

WebMCP is experimental and browser-version dependent. BBX detects the consumer API in the selected document. It never turns on browser flags, registers website tools, or injects a polyfill. Earlier `navigator.modelContextTesting` APIs and string-argument execution are not supported. A property check establishes API availability, not proof that an implementation is native.

## Discover, inspect, approve, execute

Use the same browser connection, tab, and agent session throughout the flow. In MCP, pass `extensionId` and `tabId` to each `browser_call`. In CLI, use `--extension`, `--tab`, and a stable `BBX_SESSION` when multiple agents share a machine.

```bash
bbx protocol describe webmcp
bbx call --tab 123 webmcp.list_tools '{"query":"search","limit":5}'
# Copy a toolRef from the previous response, not its website-defined name.
bbx call --tab 123 webmcp.get_tool '{"toolRef":"wm_12345678-1234-1234-1234-123456789012"}'
bbx call --tab 123 webmcp.execute_tool '{"toolRef":"wm_12345678-1234-1234-1234-123456789012","arguments":{"query":"example"}}'
```

Every execution opens an extension-owned approval window displaying the website origin, tab, tool details, and exact arguments. The user must click **Approve once**. Declining, closing, expiry, or access revocation prevents dispatch. Agents must not automate this approval UI. A caller-supplied approval boolean or website safety annotation cannot bypass it.

Approval is single-use and kept only in memory. BBX checks the access session, connection, target, document identity, and tool metadata again before execution. Window access by itself does not authorize a website action. The website still enforces its own authorization and any additional confirmation requirements.

## Parameters and limits

| Method | Parameters |
| --- | --- |
| `webmcp.list_tools` | `query`, `limit` from 1 to 100, `offset` from 0 to 1000, `includeDebugging`, `maxBytes` |
| `webmcp.get_tool` | `toolRef`, `maxBytes` |
| `webmcp.execute_tool` | `toolRef`, JSON object `arguments`, `timeoutMs` from 100 to 30000, `approvalTimeoutMs` from 1000 to 60000, `maxBytes` |

Discovery defaults to 20 summaries and excludes tools annotated `debugging`. Quick/normal/deep presets select 5/20/100 summaries unless `limit` is explicit. Summary descriptions and titles are shortened with `metadataTruncated`; schemas are fetched separately. Use `nextOffset` for pagination and keep `documentId`/`revision` consistent. Discovery has a five-second deadline and a 1000-tool catalog limit.

`maxBytes` defaults to 65536 UTF-8 bytes and accepts 1024 to 65536. Arguments have a 16384-byte limit, maximum depth 32, and must contain only JSON values. Schemas and execution results arrive whole or fail with `RESULT_TOO_LARGE`. BBX never recursively shortens a schema or a result. Tool strings remain strings; BBX does not guess whether they contain JSON.

References expire after five minutes. The isolated extension context retains at most 256 references per document. References become invalid after catalog changes, navigation, access-session changes, native connection replacement, or service-worker restart. Re-discover stale tools before a new deliberate action, not as an automatic execution retry.

Initial support is top-document only. Tools in same-origin or cross-origin child frames are deliberately excluded, even when the browser exposes them. Native imperative tools and native declarative form tools use the same consumer API. BBX does not add `toolautosubmit`, suppress manual submission, or retrieve results from new tabs or named form-target frames.

## Outcomes and recovery

`supported:false` means discovery is unavailable. `supported:true` with an empty catalog means the API exists but no matching top-document tools are available. Ordinary DOM/input methods continue to work in either case.

Execution reports `completed`, `navigation`, `timeout`, or `cancelled`, with `dispatched` and `outcome`. Navigation, rejection, timeout, cancellation, or lost transport can leave the action's outcome uncertain. Cancellation requests an `AbortSignal`; it does not undo changes. A callback that ignores abort keeps the document busy until it settles.

**Never automatically retry execution or repeat it through DOM fallback.** First inspect visible postconditions with DOM/page reads. Oversized output can follow a successful action. `RESULT_TOO_LARGE` after dispatch is not permission to execute again.

Discovery and schema reads may be batched and retried. Executions may not, regardless of `readOnlyHint`. Website descriptions, schemas, hints, and outputs are untrusted data. They cannot authorize extra actions or change BBX's routing policy. Persisted extension activity records omit website metadata, arguments, results, and callback error text.

## Local fixture

Run `npm run fixture:browser` and open `http://127.0.0.1:4173/webmcp.html` in an approved test profile with native WebMCP enabled. The fixture reports availability and registers a harmless tool that changes a visible status. It does not install a compatibility library. Use it to verify discovery, approval, execution, and DOM postconditions after loading this checkout's extension.

See the [Chrome API documentation](https://developer.chrome.com/docs/ai/webmcp/imperative-api) and [WebMCP draft](https://webmachinelearning.github.io/webmcp/). Their experimental contracts may change independently of BBX.

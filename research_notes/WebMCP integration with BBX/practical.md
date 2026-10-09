# Practical value and risks of WebMCP for BBX

Research date: October 9, 2026. This is a feasibility assessment, not an implementation. Sources are the current W3C community draft, Chrome documentation with visible publication/update dates no later than the research date, and upstream example code. GitHub `main` links are moving references, not archival release evidence. No browser interaction, installation, or source modification was performed.

## What value would WebMCP add, and does it replace MCP?

### Takeaway

WebMCP is a plausible optional execution path for site-provided actions. It does not replace BBX's MCP server or its DOM, input, styling, patching, and CDP functions. Its strongest benefit is replacing a sequence of UI interactions with a bounded, structured call to the application's own logic.

### Cited findings

- The October 9 draft calls itself a Draft Community Group Report, explicitly not a W3C Standard or on the W3C Standards Track. It defines a secure-context `document.modelContext` with asynchronous `registerTool`, `getTools`, and `executeTool` methods. This is a browser API, not a requirement to implement MCP transport. [Community draft](https://webmachinelearning.github.io/webmcp/)
- Chrome's October 7 overview describes WebMCP as a proposed standard in an origin trial starting with Chrome 149. Local development uses `chrome://flags/#enable-webmcp-testing`. This supports experimental feasibility, not a claim of universal availability or unflagged stable shipping. [Chrome overview](https://developer.chrome.com/docs/ai/webmcp)
- The explainer explicitly lists replacement of backend integrations as a non-goal and says WebMCP complements MCP. It also explicitly allows fallback to ordinary browser automation when the offered tools cannot accomplish the task. [Explainer, goals and existing actuation](https://github.com/webmachinelearning/webmcp/blob/main/README.md)
- Chrome's comparison says WebMCP is neither an extension nor a replacement of MCP, and omits server-side concepts such as MCP resources. Its tools are live-page dependent and disappear on navigation or tab closure. [Chrome comparison](https://developer.chrome.com/docs/ai/webmcp/compare-mcp)
- The draft's non-normative agent-observation section does not prescribe the format used to expose page tools to the agent. It permits MCP, proprietary function calling, or other formats, and permits caching/filtering/diffing observations before adding them to model context. [Draft, page observations](https://webmachinelearning.github.io/webmcp/#observations)
- Site-owned tool callbacks can reuse application logic, call APIs as necessary, and update the same visible UI used by the human. This avoids inferring functionality from screenshots or DOM and helps keep front-end state aligned with execution. Network work performed by a callback still requires its ordinary server calls. [Explainer, in-browser flow](https://github.com/webmachinelearning/webmcp/blob/main/README.md); [Chrome overview](https://developer.chrome.com/docs/ai/webmcp)
- Chrome directly links official examples for an imperative pizza builder, imperative React flight search, and declarative restaurant reservation. Its overview also links an appointment-booking side-by-side comparison. These are demonstrations, not comparative performance benchmarks. [Chrome demo list](https://developer.chrome.com/docs/ai/webmcp#demo); [Appointment comparison](https://googlechromelabs.github.io/webmcp-tools/demos/explainer/#compare)
- The GoogleChromeLabs collection includes flight search/filter/read-result operations, pizza configuration, restaurant forms, and multi-page Mystery Doors. It also includes WebMCP Evals, a CLI for checking tool selection against test cases. The repository expressly says it is not an officially supported Google product. [Example/demo collection](https://github.com/GoogleChromeLabs/webmcp-tools)
- Chrome documents extension-based access via content scripts and host permissions. The example extension's actual content script reads `document.modelContext`, calls `getTools`, subscribes to tool changes, finds a tool belonging to the current window, and awaits `executeTool`. It retains the runtime message channel while execution is pending. This is concrete evidence that an extension consumer is feasible without building a new agent inside BBX. [Chrome agent-security guidance](https://developer.chrome.com/docs/agents/security); [Example content script](https://github.com/GoogleChromeLabs/webmcp-extension/blob/main/extension/content.ts)
- The Model Context Tool Inspector is linked by Chrome and supports inspecting and executing tools manually or with Gemini. Its README requires a testing flag on Chrome 150.0.7861.0 or later and likewise disclaims supported-product status. [Inspector README](https://github.com/beaufortfrancois/model-context-tool-inspector); [Chrome overview](https://developer.chrome.com/docs/ai/webmcp)

### Inferences

- Recommendation: keep the existing agent-to-BBX MCP connection. WebMCP belongs behind it as one page capability, rather than replacing the server or automatically publishing every page tool as a new top-level MCP tool.
- Recommendation: treat this as an application-action improvement, not a DOM/style inspection improvement. BBX must still inspect computed styles, diagnose layout, apply reversible patches, and verify actual page state with its current methods.
- Likely benefits are fewer agent turns, fewer selectors, and less UI-state reconstruction for cooperating sites. Benefits depend on site adoption and tool quality. A single large discovery payload could cost more tokens than BBX's current focused DOM query.
- BBX already offers a comparatively token-efficient DOM path, so comparisons against screenshot-only agents would overstate the incremental gain. Benchmark against BBX itself.

### Gaps

- No primary benchmark located quantifies token savings, latency, reliability, or adoption for WebMCP integrated into BBX. Chrome's speed/reliability statements are design claims, not BBX measurements.
- Chrome's older comparison page says its APIs interact exclusively with built-in browser agents. This conflicts with the newer overview, agent-security page, explainer, and example extension, which explicitly support extensions and in-page agents. Do not use that older exclusivity statement to reject BBX feasibility. [Older comparison](https://developer.chrome.com/docs/ai/webmcp/compare-mcp); [Extension-aware guidance](https://developer.chrome.com/docs/agents/security)

## What are the security and execution boundaries?

### Takeaway

Structured tools remove UI guesswork, not trust problems. A page tool runs with the user's live session and can misdescribe its effects. BBX must enforce target scope and human approval independently, and handle pending execution, navigation, and frames without assuming a successful return proves a successful action.

### Cited findings

- Chrome warns that agents operate in authenticated browser sessions. The draft explains that existing page cookies/session state can permit purchases, transfers, account changes, disclosures, and deletions without additional verification. Calling a tool does not grant a narrower, independent identity. [Chrome agent-security guidance](https://developer.chrome.com/docs/agents/security); [Draft, intent misrepresentation](https://webmachinelearning.github.io/webmcp/#misrepresentation-of-intent)
- Both the draft and Chrome identify malicious metadata and contaminated tool outputs as prompt-injection risks. Names, descriptions, parameter descriptions, and schema text can contain instructions. A trusted site's response can also contain hostile user comments. [Draft, prompt injection](https://webmachinelearning.github.io/webmcp/#prompt-injection); [Chrome agent-security guidance](https://developer.chrome.com/docs/agents/security)
- The draft explicitly says there is no guarantee that declared intent matches actual behavior and identifies privacy leakage through over-parameterization. A tool can solicit personal or cross-site data that is unnecessary for the user's task. [Draft, intent](https://webmachinelearning.github.io/webmcp/#misrepresentation-of-intent); [Draft, over-parameterization](https://webmachinelearning.github.io/webmcp/#privacy-leakage-over-parameterization)
- `readOnlyHint`, `untrustedContentHint`, and `consequentialHint` are annotations. Chrome recommends confirmation, origin restrictions, payload/token limits, and treating unknown tools as mutating. The example extension expressly trusts annotations for demonstration and warns that a harmful tool can claim to be read-only or claim its output is trusted. It is not a production-ready security template. [Chrome annotations](https://developer.chrome.com/docs/ai/webmcp/imperative-api); [Chrome agent-security guidance](https://developer.chrome.com/docs/agents/security); [Example extension trust boundary](https://github.com/GoogleChromeLabs/webmcp-extension#trust-boundary)
- Chrome recommends short metadata/output budgets, including 500 characters for descriptions, 150 for parameter descriptions, and 1.5K for an individual output. These are recommendations, not standardized enforced limits. Its agent guidance recommends rejecting oversized inbound responses. [Tool-security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools); [Agent-security guidance](https://developer.chrome.com/docs/agents/security)
- The draft defines asynchronous execution and cancellation signals. Registration-time abort removes availability but does not cancel callbacks already running. Execution-time abort is separate and is passed to the callback, allowing cooperative cancellation of fetches or other work. [Draft, pending executions and unregistering](https://webmachinelearning.github.io/webmcp/#pending-tool-executions); [Chrome cancellation](https://developer.chrome.com/docs/ai/webmcp/imperative-api#handle_tool_cancellation)
- The draft defines an `AbortError` for a target document unloading before execution finishes. Its explainer still lists cross-document responses, progress reporting, and user prompting/elicitation as open questions. Chrome's imperative documentation instead says execution can return null when navigation occurs. These sources do not establish one uniform cross-navigation contract. [Draft, execution errors](https://webmachinelearning.github.io/webmcp/#tool-execution-error); [Explainer, open questions](https://github.com/webmachinelearning/webmcp/blob/main/README.md#open-questions); [Chrome execution](https://developer.chrome.com/docs/ai/webmcp/imperative-api#execute_tool)
- Chrome declarative tools derive schemas from forms with `toolname` and `tooldescription`. By default the user manually submits after fields are filled. `toolautosubmit` enables submission on invocation. A handler can use `preventDefault`, `agentInvoked`, and `respondWith` to supply asynchronous results instead of ordinary form navigation. [Chrome declarative API](https://developer.chrome.com/docs/ai/webmcp/declarative-api)
- Chrome documents declarative tools, but the current explainer says the declarative API is explored separately and is not part of the community specification. It is therefore a Chrome experiment with a separate design, not a normative guarantee from the imperative draft. [Explainer, declarative exploration](https://github.com/webmachinelearning/webmcp/blob/main/README.md#future-exploration-declarative-api); [Chrome declarative API](https://developer.chrome.com/docs/ai/webmcp/declarative-api)
- The example extension has additional cross-document handling that reads a `script[type="application/ld+json"]` result after an iframe loads or from a newly opened tab. This is example-specific behavior, not a portable result contract promised by the current draft. [Example content script](https://github.com/GoogleChromeLabs/webmcp-extension/blob/main/extension/content.ts); [Draft API](https://webmachinelearning.github.io/webmcp/#api)
- `tools` Permissions Policy defaults to `self`. Cross-origin iframe registration needs delegation such as `allow="tools"`. Cross-origin discovery additionally needs the owner tool's `exposedTo` to include the caller and the caller's `fromOrigins` to include the owner. Neither condition alone is sufficient. Registered tools include origin and owning window. [Chrome iframe rules](https://developer.chrome.com/docs/ai/webmcp/imperative-api#cross-origin_iframes); [Draft API](https://webmachinelearning.github.io/webmcp/#api)
- Extensions have a separate host-permission authority and can already execute page JavaScript without WebMCP. The draft's internal browser-agent observation mechanism is implementation-defined; it is not the same contract as `getTools` for an in-page caller. [Chrome agent-security guidance](https://developer.chrome.com/docs/agents/security); [Draft observations](https://webmachinelearning.github.io/webmcp/#observations)
- A tool can be unregistered then re-registered with the same name and a different schema between discovery and execution. The draft explicitly notes that this race is not protected. Full schema validation and structured output schemas remain open questions in the explainer. [Draft race note](https://webmachinelearning.github.io/webmcp/#unregistration-execution-race); [Explainer open questions](https://github.com/webmachinelearning/webmcp/blob/main/README.md#open-questions)
- The GoogleChromeLabs polyfill uses page globals, a JavaScript `ModelContext`, and `postMessage` requests. Its message handlers return local tools and execute requests without the native `exposedTo` authorization check; its registration code does not enforce native Permissions Policy. This is concrete nonstandard/polyfill behavior and cannot substitute for native security tests. [Polyfill source](https://github.com/GoogleChromeLabs/webmcp-tools/blob/main/demos/shared/webmcp-polyfill.js)

### Inferences

- Recommendation: distinguish three approvals. BBX window access permits the bridge to reach a window; agent task authorization permits a particular action; a site's confirmation or form-submit step may still require human input. None should be inferred from the others.
- Recommendation: consider all metadata and outputs untrusted regardless of annotations. Preserve the annotations as useful claims, but never use a site's `readOnlyHint` to bypass BBX's policy for an unknown origin/tool. Scope approvals to exact profile, tab, document/frame, origin, tool version, and arguments.
- Recommendation: reject irrelevant origins and unnecessary personal inputs deterministically. An allowlisted website can still return third-party injection. Spotlighting or classifiers are extra defenses, not guarantees.
- Recommendation: a caller timeout or abort does not undo a purchase, network mutation, or other work already performed. Report an uncertain outcome and inspect postconditions before retrying or switching to DOM input. Otherwise a fallback could duplicate the action.
- Recommendation: classify navigation, a pending human submission, and execution error separately from success. A long-waiting form must not hold a BBX daemon request indefinitely. A bounded status/continuation design may eventually be needed, but the first experiment should use bounded asynchronous tools and stop on a human-confirmation wait.
- Recommendation: initially restrict to the top document. Later iframe support should use extension-known frame/document identities and owner origin rather than tool name alone. Do not use broad extension injection to bypass a site's cross-origin exposure policy merely because host permissions permit it.
- Recommendation: preserve ordinary website authorization and validation. WebMCP discovery is not authorization and schemas are not proof of enforced validation.

### Gaps

- `requestUserInteraction()` appears in Chrome's September security page with a draft link, but that interface/method is absent from the October 9 fetched draft. The current explainer treats elicitation as open work. Do not promise portable native human confirmation from this API. [Chrome security page](https://developer.chrome.com/docs/ai/webmcp/secure-tools); [Current draft API](https://webmachinelearning.github.io/webmcp/#api); [Explainer open questions](https://github.com/webmachinelearning/webmcp/blob/main/README.md#open-questions)
- Current official docs use `document.modelContext`, not older `navigator.modelContext` examples. Chrome also documents migration of stringified arguments in Chrome 155 and events/debugging changes in Chrome 156. Those version notes describe API evolution; this research did not verify the user's installed Chrome or the shipping status of each milestone. [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api); [Chrome declarative API](https://developer.chrome.com/docs/ai/webmcp/declarative-api)
- No live test established whether BBX's existing execution context, request timeout, output limits, or frame routing are sufficient. Feasibility is supported by upstream extension code, not a completed BBX integration.

## What proof of concept is justified, and what priority should it have?

### Takeaway

Recommendation: a small, opt-in proof of concept has medium exploratory priority. Production promotion should wait for native compatibility, meaningful savings against BBX's existing structured automation, and approval/failure tests. Do not make WebMCP a dependency of ordinary bridge operation.

### Cited findings

- Native extension discovery and execution already exist in upstream example code. No separate model server is needed to copy the browser-access pattern; that example's local AI server is for its own chat interface. [Example architecture](https://github.com/GoogleChromeLabs/webmcp-extension); [Content script](https://github.com/GoogleChromeLabs/webmcp-extension/blob/main/extension/content.ts)
- Official examples cover bounded imperative configuration, search/filter/result reading, declarative confirmation, and multi-page navigation. They supply suitable independent test targets rather than requiring a production site integration first. [Demo collection](https://github.com/GoogleChromeLabs/webmcp-tools)
- The draft allows filtering/caching/diffing tool observations, and Chrome's security guidance recommends inbound limits and task-relevant origin restrictions. These are compatible with BBX's scoped, token-efficient design. [Draft observations](https://webmachinelearning.github.io/webmcp/#observations); [Chrome agent-security guidance](https://developer.chrome.com/docs/agents/security)

### Inferences

#### Proposed scope, not an implementation commitment

1. Use one approved Chrome profile and an explicitly selected tab. Feature-detect the native API and return bounded capability states such as unavailable, disabled, no tools, or tools available. Do not enable flags, add permissions, install a polyfill, or open sites automatically.
2. Start with generic BBX calls and its existing execution mechanism for a development-only experiment. Keep caller-provided tool definitions out of privileged tool registration. If the experiment warrants dedicated methods later, use generic discovery/inspection/execution concepts, not pizza/flight-specific RPCs.
3. Return a short catalogue containing identity, owner origin/document, name, and annotation claims. Fetch one complete schema/description on demand. Apply BBX budgets before returning data to the agent; do not silently truncate a schema into invalid JSON. Label metadata and responses as page-provided untrusted data.
4. Execute one selected top-document tool at a time with explicit arguments, policy approval, a deadline, and bounded output. Retain any owning `Window` object inside the browser context rather than attempting to JSON-serialize it. Re-discover and compare metadata immediately before execution; fail closed on navigation or change. Re-discovery reduces, but cannot fully remove, the draft's name-reuse race.
5. Test native imperative pizza/search operations first. Add a declarative prefill/manual-submit case to discover confirmation behavior without automatically clicking Submit. Defer cross-origin frames, new-tab result recovery, streaming/progress, and polyfill consumers.
6. Verify the actual DOM/UI postcondition with existing BBX reads. If the API/tool is missing, use normal focused DOM/input navigation. If a mutation was attempted and its result is uncertain, inspect or ask the user before fallback. Never automatically repeat a consequential action.

#### Proposed acceptance tests

These are proposed gates, not measured results.

| Test | Passing result |
| --- | --- |
| Native available versus absent | Works on an enabled experimental build; ordinary BBX reads still work when API is absent. Reports capability state without changing browser configuration. |
| Discovery budgets | Catalogue stays within a declared BBX response budget; schema inspection is opt-in; oversized metadata is rejected/identified and never automatically injected into model tool definitions. |
| Imperative action | Pizza configuration or flight filtering produces the expected visible UI and result; a focused DOM read independently confirms it. |
| Session boundary | Test site sees its ordinary logged-in state, but BBX neither exports cookies nor requests a new credential flow. Approval does not transfer to a different profile, tab, origin, or document. |
| Human approval | Denied invocation never reaches the callback. A consequential tool cannot bypass approval by claiming read-only. An unknown tool does not receive blanket execution authority from bridge window access. |
| Declarative manual submit | Fields are filled and visible; the human confirmation step remains pending. BBX does not click Submit or infer successful completion. |
| Autosubmit distinction | An autosubmitting mutation is classified and approved before invocation, unlike a harmless test search. Test only simulated transactions. |
| Async/cancel/error | Bounded asynchronous success, rejection, serialization failure, and timeout have distinct outcomes. Cancellation is surfaced without claiming that side effects rolled back. |
| Navigation/staleness | Reload, close, tool removal, and metadata/schema replacement invalidate the old handle. Navigation yields a classified uncertain/interrupted outcome, not fabricated success or automatic retry. |
| Duplicate names/frames | Same-named tools cannot be confused across documents. For the initial top-frame scope, cross-origin tools are explicitly out of scope. Later tests must require policy delegation, exposure, and caller origin selection independently. |
| Injection/exfiltration | Malicious descriptions, schema text, result instructions, and requested cross-site PII cannot expand deterministic origin/action permissions. Record model susceptibility separately; do not claim total prompt-injection resistance. |
| Oversized output | Reject oversized data before it reaches the model; return a bounded diagnostic. Current DOM reads remain available as a fallback. |
| Fallback safety | Missing tools use normal DOM/input. An uncertain attempted mutation cannot cause duplicate execution through fallback. |
| Incremental value | On the same tasks and postconditions, measure total model-visible tokens, bridge calls, retries, success rate, and latency against BBX structured DOM/input, not screenshot-only automation. |

- Proposed value gate: across at least 20 repetitions of a multi-step search/configuration task, require no lower task success rate and at least a 25% reduction in model-visible tokens or bridge calls relative to BBX's existing path. This threshold is a project decision, not a source claim. Report discovery costs separately and avoid spending a large schema catalogue for one trivial action.
- Proposed security gate: all scope, denied-approval, oversized-data, stale-document, and duplicate-action tests must pass before real authenticated mutation tools are considered. Begin with local fixtures or official simulated demos, never real checkout/account deletion.
- Priority recommendation: do the bounded experiment after core routing/access/reliability work, not a broad rewrite. Native extension examples make it credible; active API changes and unverified BBX-specific savings make default-on production support premature. Raise priority if users regularly automate WebMCP-enabled sites or want structured site diagnostics. For predominantly arbitrary-site inspection and CSS patching, keep it optional and lower priority.

### Gaps

- The existing BBX protocol and implementation were not audited in this research. A feasibility prototype must check timeout handling, native-versus-polyfill identification, cancellation propagation, serializable tool handles, output caps, and access checks before selecting an implementation design.
- No credible evidence establishes ecosystem-wide availability or a compatibility contract for polyfills and legacy testing APIs. Keep native draft APIs, Chrome experiments, and third-party/polyfill APIs as separate compatibility categories.

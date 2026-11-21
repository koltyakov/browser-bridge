---
name: browser-bridge
description: 'Inspect and control the user''s real Chrome tabs through Browser Bridge (MCP browser_call/browser_batch tools or the bbx CLI): structured DOM, text, styles, console, network, form input, multi-step flows, and reversible CSS/DOM patches at lower token cost than screenshots.'
---

# Browser Bridge

Browser Bridge reads and drives the tabs the user already has open in Chrome through a local extension. Use the MCP tools when they are connected (`browser_call` reaches every method, `browser_batch` runs independent reads in parallel). Use the `bbx` CLI for setup, diagnostics, or hosts without MCP; `bbx call <method> '{...}'` reaches the same methods. Permission prompts come from the host agent; in permission-ask hosts, prefer the single `browser_call` tool so the user approves one tool.

## Start and route

1. Check readiness: MCP `browser_call` method `health.ping`; CLI `bbx status`. Stop if no extension is connected (`bbx doctor` explains why).
2. Find the tab: `tabs.list` (paged by 30; follow `pagination.nextOffset`). Reuse its `tabId`, plus `extensionId` when several profiles are connected and `destinationId` (`--remote <name>`) for a remote browser, on every call and every batch item.
3. Work in existing tabs. Open one with `tabs.create` only when the user asks or the task needs a fresh page. New tabs open in the background.
4. Keep working in the target tab when the user switches tabs; background reads, input, navigation, and screenshots work. Activate a tab only when you opened it and the active tab is also yours, or with the user's permission.
5. If window access is off, call `access.request` once, ask the user to click **Enable** in the Browser Bridge popup or side panel, then retry once. `ACCESS_DENIED` with `details.reason: "policy_setting_disabled"` is a user setting to change, never to bypass; `access.wait_for_change {revision, timeoutMs}` waits for it.

## Read, cheapest first

| Need | Method |
| --- | --- |
| URL, title, readiness, framework hints | `page.get_state` |
| What can I act on? | `dom.get_accessibility_tree {source: "dom", interactiveOnly: true}`: lines like `- button "Save" [el_k7q2_1f]` whose refs are input targets |
| Article or documentation text | `page.extract_content` |
| All visible text | `page.get_text {textBudget}` |
| Specific elements | `dom.query {selector, maxNodes, attributeAllowlist}` lists every match with checkbox state; `dom.find_by_role {role, name}`, `dom.find_by_text {text}` |
| One element | `dom.get_text`, `dom.get_attributes`, `dom.describe` with `target` (same shapes as input) |
| CSS and layout | `styles.get_computed {properties}`, `layout.get_box_model`, `styles.get_matched_rules` |
| Console and API calls | `page.get_console`, `page.get_network`; call each with `clear: true` before reproducing an issue |

- Keep budgets tight (`maxNodes` ≤ 20, `textBudget` ≤ 800, attribute allowlists) and widen only on `truncated`. Presets: `budgetPreset: "quick" | "normal" | "deep"`.
- Reuse `elementRef` values; re-query after `_registryPruned: true` or `ELEMENT_STALE`.
- Batch independent reads (`browser_batch`, `bbx batch '[...]'`). `batch` is not a `browser_call` method.
- Escalate only when structured reads cannot answer: `screenshot.capture_element`, a tight `screenshot.capture_region`, `page.evaluate`, CDP-source accessibility trees, `cdp.*`. These attach the debugger.
- Exact storage values are sensitive: read `page.get_storage` metadata first and call `sensitive.read` for one key only when needed, never batched or retried.
- Unfamiliar method: `protocol.describe {method}` for its schema, `{query: "..."}` to search. In MCP scripts, `resultMode: "data"` beside `method` returns the raw result of a batch-safe read.

## Act

Pass a locator as the target and let the action wait for it:

```json
{"target": {"role": "button", "name": "Save"}}
{"target": {"label": "Email"}}
{"target": {"text": "Load more"}}
{"target": {"placeholder": "Search"}}
{"target": {"testId": "submit"}}
{"target": {"selector": "#cart .item", "nth": 1}}
{"target": {"elementRef": "el_k7q2_1f"}}
```

Run known steps in one `input.perform`; it stays inside the browser and needs no model round trip per step:

```json
{"method": "input.perform", "params": {"returnLastResult": true, "steps": [
  {"method": "input.fill", "params": {"target": {"label": "Email"}, "value": "ada@example.test"}},
  {"method": "input.click", "params": {"target": {"role": "button", "name": "Sign in"}}},
  {"method": "dom.wait_for", "params": {"text": "Welcome"}},
  {"method": "dom.get_text", "params": {"target": {"selector": "#flash"}}}
]}}
```

- Steps may also be written flat: `{"action": "fill", "target": {...}, "value": "..."}`. Allowed steps are input actions, `navigation.navigate`, `viewport.scroll`, waits, and `page.get_state`, `page.get_text`, `dom.query`, `dom.get_text` reads. Steps after a navigating click see the new page.
- `input.perform.outcomes` verifies DOM, URL, or fetch/XHR conditions in the same call; `OUTCOME_NOT_MET` means inspect, not retry.
- Field methods: `input.fill {value}` (framework-safe), `input.type {text}` (keystrokes; types into the focused field when no target), `input.select_option {values | labels}` (visible option text works), `input.set_checked {checked}`, `input.press_key {key}`.
- Click, key, check, select, and submitting fills return `effects` (URL change, dialogs, messages, focus, target state). Read them before taking another snapshot, but wait for a specific outcome before claiming success.
- Navigate a tab with `navigation.navigate {url}`; `page.wait_for_load_state {url, urlMatch}` waits for a client-side route.
- Pages that require a real user gesture (audio, popups, clipboard, fullscreen) need `executionMode: "auto"` or `"cdp"`.
- Never send input as parallel tool calls, keep `continueOnError` false, and stop at decisions that need new evidence or user approval.

## Recover

Decide from the response's `recovery`, the method, and its params, not the code alone. Never replay a failed, uncertain, or partial mutation or `input.perform`: inspect the page first. Retry only with evidence the action never ran (`aftermath.dispatch: "not_started"` or `details.dispatched: false`).

| Code | Do |
| --- | --- |
| `ELEMENT_NOT_FOUND` | Read `details.sameRole` and `hiddenMatches`; fix the locator or inspect with `dom.find_by_role`. |
| `ELEMENT_AMBIGUOUS` | Add `nth`, a narrower locator, or a container `selector`. |
| `ELEMENT_OBSCURED` | Read `details.blocker`; close the overlay or wait for it. |
| `RESULT_TRUNCATED` | Scope the locator with a container `selector` instead of retrying. |
| `DIALOG_BLOCKED` | `page.handle_dialog {action: "inspect"}`, then `accept` or `dismiss` with `expectedDialogId`. The interrupted action may already have run. |
| `TAB_MISMATCH` | Rediscover with `tabs.list`; never guess IDs. |
| `TIMEOUT` | Inspect state before any new action. |

Per-code guidance, health diagnostics, and multiple profiles: [access and recovery](references/access-and-recovery.md).

## Patch and verify

Prototype fixes with `patch.apply_styles` (prefer) or `patch.apply_dom`, verify with a scoped read and `page.get_console`, then `patch.rollback` before finishing unless the user wants the patch kept. For before/after DOM diffs use `dom.baseline.create`, `compare`, and `release`. After editing source behind a dev server, wait for the new text or attribute rather than an element that already exists. See [patch workflow](references/patch-workflow.md).

## CLI quick reference

```bash
bbx status | doctor | restart | logs     # readiness, diagnostics, daemon, request log
bbx tabs                                 # list tabs and their IDs
bbx call --tab <id> <method> '{...}'     # any method on one tab, raw result
bbx --remote <name> call --tab <id> input.perform '{"steps":[...],"returnLastResult":true}'
bbx batch '[{"method":"page.get_state"},{"method":"page.get_text"}]'
bbx protocol describe <method|group>     # signatures before guessing params
bbx dom-query <selector> | find <text> | find-role <role> [name] | text <ref>
bbx click <ref> | fill <ref|selector> <value> | type <ref> <text> | press-key <key>
bbx navigate <url> | reload | back | screenshot <ref> [outPath]
bbx patch-style <ref> prop=val | patches | rollback <patchId>
bbx eval [--await] <expression>          # debugger-backed; last resort
```

Wrap refs as `target: {elementRef}`, never a top-level `ref`. Shortcut output is `{ok, summary, evidence}`; `bbx call` prints the raw result or `{ok: false, error, recovery}`. More: [CLI reference](references/cli-reference.md).

## References (load when needed)

- [Interaction](references/interaction.md): input methods, sequences, outcomes, form controls, hover, drag, touch, multi-tab
- [Token efficiency](references/token-efficiency.md): budgets, decision tree, debugger escalation, baselines
- [Workflows](references/workflows.md): CSS debugging, text fixes, API verification, HMR, user flows
- [Access and recovery](references/access-and-recovery.md): access settings, profiles, working-tab rules, errors
- [Protocol](references/protocol.md): every method and error code
- [WebMCP](references/webmcp.md): website-provided tools; execution needs user approval in an extension window that must never be automated
- [Files](references/files.md), [emulation](references/emulation.md), [recording](references/recording.md), [playbooks](references/playbooks.md), [capture context](references/capture-context.md), [UI workflows](references/ui-workflows.md), [Tailwind](references/tailwind.md) (load when `page.get_state` reports `hints.tailwind: true`)

Return findings as a verdict, the tab and origin, and the minimal evidence; no raw HTML or base64 images.

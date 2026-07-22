# Usage Scenarios

Browser Bridge is best when you need the state that already exists in a real Chrome tab: logged-in sessions, seeded storage, feature flags, SPA state, and whatever the page actually rendered.

If you need repeatable clean-room automation for tests or CI, use Playwright or another browser automation stack instead.

## 1. Debug a broken layout in the real page

Use this when the bug only reproduces in your current logged-in or feature-flag state.

Ask an MCP-capable agent:

> Use Browser Bridge MCP to inspect why the sidebar overlaps the main content.
>
> If your client supports subagents, delegate the investigation to a smaller low-cost worker first.

Ask a CLI-skill agent:

> Use the browser-bridge skill to inspect the broken sidebar layout and tell me which computed styles are causing it.

Useful direct commands:

```bash
bbx batch '[{"method":"page.get_state"},{"method":"dom.query","params":{"selector":".sidebar","maxNodes":20,"maxDepth":4,"textBudget":600}}]'
bbx dom-query .sidebar
bbx box .sidebar
bbx styles .sidebar display,position,width,left,right,gap
bbx matched-rules .sidebar
```

## 2. Verify that a local code change actually rendered

Use this after editing source, before assuming the fix worked.

Typical prompt:

> Check whether the latest navbar change rendered correctly in the browser, and compare the live spacing against the intended layout.

Useful direct commands:

```bash
bbx call page.get_state
bbx dom-query nav
bbx styles nav gap,padding,align-items
bbx call input.scroll_into_view '{"target":{"selector":"nav"}}'
bbx screenshot nav ./tmp/navbar.png
```

## 3. Debug a form or interaction issue

Use this when a click, keyboard interaction, or form control does not behave as expected.

Typical prompt:

> Use Browser Bridge to inspect the submit button, confirm whether it is disabled or covered, then try the interaction again.

Useful direct commands:

```bash
bbx describe button[type="submit"]
bbx box button[type="submit"]
bbx call input.scroll_into_view '{"target":{"selector":"button[type=\"submit\"]"}}'
bbx call page.get_console '{"clear":true}'
bbx call page.get_network '{"clear":true}'
bbx click button[type="submit"]
bbx call dom.wait_for '{"selector":".success","state":"visible","timeoutMs":5000}'
bbx console error
bbx network 20
```

Targeted click, focus, type, fill, press-key, checked-state, option-selection,
hover, and drag selection checks visibility, disabled/inert state, rendered
bounds, and pointer obstruction, returning actionability metadata or a
structured failure instead of silently guessing. `cdp_press_key` and
`scroll_into_view` use separate contracts. For browser-native pointer/text
dispatch, use raw input calls with `executionMode: "cdp"` only on click, hover,
drag, type, or fill. After either path, verify application state with a targeted
wait or read; event dispatch alone is not proof of success.

## 4. Prove a live CSS or DOM fix before editing source

Use this when you want to validate the fix in the page first, then port it into
the codebase.

Typical prompt:

> Inspect the hero spacing, patch the live page until it looks correct, then tell me the minimal source change to make.

Useful direct commands:

```bash
bbx patch-style .hero gap=24px padding=32px
bbx patch-text .hero-title "New heading"
bbx patches
bbx rollback <patchId>
```

## 5. Collect compact evidence instead of taking full screenshots

Use this when you want token-efficient evidence for the agent.

Typical prompt:

> Read the visible page state, console errors, and the box model for the checkout summary without dumping the whole DOM.

Useful direct commands:

```bash
bbx call page.get_state
bbx console all
bbx network 20
bbx box .checkout-summary
bbx text .checkout-summary medium
```

If `page.get_console` or `page.get_network` returns `dropped`, the page was
noisy enough to evict older buffered entries. Narrow the repro and re-run the
read before assuming you saw the full history.

For event-driven bugs, prime both buffers with `clear: true` before reproducing the action, then read them without `clear`. The first call installs capture; clearing after reproduction would discard the evidence.

The default network buffer covers fetch/XHR and returns
`{method,url,status,duration,type,ts,size}` entries in capture order. If the bug
depends on a document, script, stylesheet, image, cache, redirect, failed
resource, WebSocket, or WebTransport, explicitly start CDP capture before the
reproduction, read it afterward, and stop it when finished:

```bash
bbx call page.get_network '{"source":"cdp","capture":"start"}'
# reproduce the issue
bbx call page.get_network '{"source":"cdp","capture":"read","limit":50}'
bbx call page.get_network '{"source":"cdp","capture":"stop"}'
```

This mode is debugger-backed and cannot recover events from before `start`.
URLs are redacted and request/response bodies, cookies, authorization values,
and complete headers are excluded.

## 6. Inspect semantics or wait for an SPA route

Use compact AX output when role/text search is insufficient, then resolve the
chosen role/name through `dom.find_by_role` before input. AX semantic
interactivity does not mean the control is currently actionable.

```bash
bbx call dom.get_accessibility_tree '{"maxNodes":50,"maxDepth":5,"interactiveOnly":true}'
bbx call page.wait_for_load_state '{"url":"/dashboard","urlMatch":"contains","waitForLoad":false}'
```

URL waits observe current state, full navigation, and SPA history/hash changes.
They report the final URL and navigation kind; `waitForLoad` means Chrome tab
status `complete`, not `networkidle`.

## 7. Handle a JavaScript dialog explicitly

Inspect first and only then accept or dismiss when that is the intended action:

```bash
bbx call page.handle_dialog '{"action":"inspect"}'
bbx call page.handle_dialog '{"action":"dismiss","expectedDialogId":"00000000-0000-4000-8000-000000000000:1"}' # replace with inspected dialogId
```

Chrome cannot atomically bind the mutation to `expectedDialogId`; it is only an
immediate pre-dispatch check. On `DIALOG_ACTION_CONFLICT`, inspect again and do
not automatically repeat the mutation.

## 8. Capture the whole document only when the page-level layout is the issue

Use this when a bug spans multiple viewports and tight crops cannot express the
problem.

Typical prompt:

> Capture the full page so we can verify how the header, hero, and footer line up across the whole document.

Useful direct commands:

```bash
bbx call input.scroll_into_view '{"target":{"selector":"main"}}'
bbx call screenshot.capture_full_page '{}'
```

## 9. Drop to the raw protocol when shortcuts are not enough

Use this when you need a method or parameter that the higher-level commands do
not expose.

```bash
bbx call page.get_state
bbx call dom.query '{"selector":".card","maxNodes":10}'
bbx batch '[{"method":"page.get_state"},{"method":"page.get_console","params":{"level":"error"}}]'
```

For a command-oriented walkthrough, see [cli-guide.md](./cli-guide.md). For
integration choices, see [mcp-vs-cli.md](./mcp-vs-cli.md).

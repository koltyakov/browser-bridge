# CLI Guide

This is the practical day-to-day guide for the `bbx` command. For install and
agent wiring, see [manual-setup.md](./manual-setup.md).

## Setup and diagnostics

```bash
bbx install
bbx install --browser chrome
bbx install --browser edge
bbx install --browser brave
bbx install --browser chromium
bbx install --browser arc
bbx install --all
bbx doctor
bbx status
bbx restart
bbx logs
bbx tabs
bbx skill
```

Use these first when Browser Bridge is not connected, the wrong tab is routed,
or you want to see the available runtime presets. `bbx install` targets Chromium
on Linux and Chrome on macOS/Windows; use `--browser` for Chrome, Edge, Brave,
Chromium, or Arc, or `--all` for all supported browsers.

`bbx doctor` is consolidated but intentionally local-only: it checks local
transport/authentication, native host manifests, extension/profile connections,
enabled-window active-tab routing, protocol versions, debugger/capture state,
daemon metrics, setup status, and recent redacted event metadata. Configured
remotes are counted but reported as `not_probed_local_only` with credentials
`unverified`; use `bbx remote test <name>` for an explicit remote probe. Doctor
does not include page content, expressions, storage/form values, network
secrets, authentication tokens, or full request payloads.

Use `bbx restart` when you want to force the local daemon and running Browser
Bridge MCP servers to reload after a CLI update, or recover from a stuck local
bridge process. MCP servers exit cleanly so their owning agents can relaunch the
current installed version.

When upgrading from a Browser Bridge version that predates coordinated MCP
restart, restart the agent once. MCP processes launched afterward register for
future `bbx restart` requests automatically.

## Inspect the page

```bash
bbx call page.get_state
bbx dom-query main
bbx describe .hero
bbx text .hero-title 1000
bbx html .hero
bbx attrs .hero id,class,data-state
bbx a11y-tree 80 4
```

These commands are usually enough to understand what rendered without dumping a
large screenshot or the whole DOM.

`dom.query` responses include `registrySize` and may include `_registryPruned:
true` when older element refs were evicted. If you see that flag, re-query
instead of reusing old refs.

## Inspect styles and layout

```bash
bbx styles .hero display,gap,padding,margin
bbx matched-rules .hero
bbx box .hero
bbx call layout.hit_test '{"x":640,"y":280}'
```

Use `styles` and `box` together when a layout bug is unclear. `matched-rules`
currently returns only the element ref, class list, and inline style; despite the
legacy name, it does not inspect stylesheet rules, specificity, or cascade order.

## Read runtime state

```bash
bbx console error
bbx network 20
bbx page-text 4000
bbx storage local authToken featureFlag
bbx perf
bbx eval 'window.location.href'
```

Reach for `eval` only when the structured reads are not enough.

## Navigate and interact

```bash
bbx navigate https://example.com
bbx reload
bbx back
bbx forward
bbx click button[type="submit"]
bbx type input[name="email"] person@example.com
bbx press-key Enter
bbx cdp-press-key --tab 123 Escape
bbx hover .menu-trigger
bbx call input.scroll_into_view '{"target":{"selector":".menu-trigger"}}'
bbx call input.click '{"target":{"selector":"button[type=submit]"},"executionMode":"cdp"}'
bbx call page.wait_for_load_state '{"url":"/complete","urlMatch":"contains","waitForLoad":false}'
bbx scroll 800
bbx resize 1440 900
```

Use `input.scroll_into_view` before a hover, click, or capture when the target
is off-screen or inside a nested scroller.

Targeted click, focus, type, fill, press-key, checked-state, option-selection,
hover, and drag calls reject missing, hidden, disabled, inert, ambiguous, or
obscured targets with structured errors, and return target-resolution plus
DOM/CDP execution metadata. `cdp_press_key` and `scroll_into_view` use separate
contracts. `executionMode` accepts `dom` or `cdp` and defaults to `dom`; CDP
supports click, hover, drag, type, and fill. This is separate from
`input.fill.mode` (`auto`, `setter`, `keystrokes`), which chooses the DOM fill
strategy. Stale recovery remains off by default; advanced callers can opt into
one strict same-document recovery with `recoverStale: true`. Recovery fails with
`ELEMENT_AMBIGUOUS` and `reason: "scan_incomplete"` rather than accepting a
match when more than 100 same-tag candidates prevent proof of uniqueness.

Always verify after input. Browser Bridge can report that an event was
dispatched, but it cannot generically guarantee the application accepted the
intended state change.

Explicit dialog handling also uses the raw path:

```bash
dialog_json=$(bbx call page.handle_dialog '{"action":"inspect"}')
dialog_id=$(printf '%s' "$dialog_json" | jq -r '.result.dialogId')
bbx call page.handle_dialog "$(jq -cn --arg id "$dialog_id" '{action:"dismiss",expectedDialogId:$id}')"
```

Never auto-accept or auto-dismiss. `expectedDialogId` is checked just before
dispatch, but Chrome cannot atomically bind the command to it; inspect again on
`DIALOG_ACTION_CONFLICT` instead of replaying the action.

## Patch the live page

```bash
bbx patch-style .hero gap=24px padding=32px
bbx patch-text .hero-title "Preview heading"
bbx patches
bbx rollback <patchId>
```

Patches keep rollback records in the current document. Use them to prove a fix
visually before editing source, then roll them back. Disabling access or
switching the enabled window triggers best-effort rollback; navigation/document
replacement invalidates page-side patch IDs. `patch.commit_session_baseline`
keeps current live changes while discarding their rollback history; it does not
write source or create a persistent browser session.

## Use the raw RPC path

Shortcuts cover the common cases. For exact methods or advanced parameters:

```bash
bbx call dom.query '{"selector":".card","maxNodes":5}'
bbx call --tab 123 page.get_state
bbx call input.scroll_into_view '{"target":{"selector":"[data-testid=\"checkout-summary\"]"}}'
bbx screenshot --format webp --quality 80 '#hero' ./tmp/hero.webp
bbx call screenshot.capture_full_page '{"format":"jpeg","quality":75}'
bbx call --tab 123 cdp.dispatch_key_event '{"key":"Escape"}'
bbx page.get_state
bbx batch '[{"method":"page.get_state"},{"method":"page.get_console","params":{"level":"warn"}}]'
```

Use `bbx call` when you need the full protocol surface. Use `bbx batch` when
you want parallel reads with one CLI round trip.

`page.get_console` and `page.get_network` also return `dropped` when hot pages
overflow their 200-entry buffers.

The `bbx network` shortcut reads low-cost fetch/XHR instrumentation. Entries are
in capture order and contain `method`, `url`, `status`, `duration`, `type`, `ts`,
and `size`. For all-resource metadata, explicitly arm CDP before reproduction:

```bash
bbx call page.get_network '{"source":"cdp","capture":"start"}'
# reproduce the issue
bbx call page.get_network '{"source":"cdp","capture":"read","limit":50}'
bbx call page.get_network '{"source":"cdp","capture":"stop"}'
```

This holds debugger ownership and is more expensive. CDP results expose capture
state and bounded resource/redirect/failure metadata, redact credentials,
fragments, and query values from URLs, and exclude bodies, cookies,
authorization values, and complete headers.

## Investigate efficiently

When the task is open-ended, treat CLI inspection as a structured-first
investigation loop:

```bash
bbx batch '[
  {"method":"page.get_state"},
  {"method":"dom.query","params":{"selector":"main","maxNodes":20,"maxDepth":4,"textBudget":600}},
  {"method":"page.get_text","params":{"textBudget":4000}}
]'
```

Add `styles.get_computed`, `layout.get_box_model`, `page.get_console`, or
`page.get_network` only when they directly help answer the question. Escalate
to screenshots after that, not before.

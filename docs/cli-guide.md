# CLI Guide

This is the practical day-to-day guide for the `bbx` command. For install and
agent wiring, see [manual-setup.md](./manual-setup.md).

## Setup and diagnostics

```bash
bbx install
bbx status
bbx doctor
bbx restart
bbx logs
bbx tabs
bbx skill
```

Use these first when Browser Bridge is not connected, the wrong tab is routed,
or you want to see the available runtime presets.

Use `bbx restart` when you want to force the local daemon to reload after a CLI
update or recover from a stuck local bridge process.

## Inspect the page

```bash
bbx call page.get_state
bbx dom-query main
bbx describe .hero
bbx text .hero-title medium
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

Use `styles`, `matched-rules`, and `box` together when a layout bug is unclear.

## Read runtime state

```bash
bbx console error
bbx network 20
bbx page-text medium
bbx storage local authToken,featureFlag
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
bbx scroll 800
bbx resize 1440 900
```

Use `input.scroll_into_view` before a hover, click, or capture when the target
is off-screen or inside a nested scroller.

## Patch the live page

```bash
bbx patch-style .hero gap=24px padding=32px
bbx patch-text .hero-title "Preview heading"
bbx patches
bbx rollback <patchId>
```

Patches are session-scoped and reversible. Use them to prove a fix visually
before you edit source.

## Use the raw RPC path

Shortcuts cover the common cases. For exact methods or advanced parameters:

```bash
bbx call dom.query '{"selector":".card","maxNodes":5}'
bbx call --tab 123 page.get_state
bbx call input.scroll_into_view '{"target":{"selector":"[data-testid=\"checkout-summary\"]"}}'
bbx call screenshot.capture_full_page '{}'
bbx call --tab 123 cdp.dispatch_key_event '{"key":"Escape"}'
bbx page.get_state
bbx batch '[{"method":"page.get_state"},{"method":"page.get_console","params":{"level":"warn"}}]'
```

Use `bbx call` when you need the full protocol surface. Use `bbx batch` when
you want parallel reads with one CLI round trip.

`page.get_console` and `page.get_network` also return `dropped` when hot pages
overflow their 200-entry buffers.

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

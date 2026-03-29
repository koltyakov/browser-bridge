# CLI Guide

This is the practical day-to-day guide for the `bbx` command. For install and
agent wiring, see [manual-setup.md](./manual-setup.md).

## Setup and diagnostics

```bash
bbx install
bbx status
bbx doctor
bbx logs
bbx tabs
bbx skill
```

Use these first when Browser Bridge is not connected, the wrong tab is routed,
or you want to see the available runtime presets.

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
bbx hover .menu-trigger
bbx scroll 800
bbx resize 1440 900
```

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
bbx page.get_state
bbx batch '[{"method":"page.get_state"},{"method":"page.get_console","params":{"level":"warn"}}]'
```

Use `bbx call` when you need the full protocol surface. Use `bbx batch` when
you want parallel reads with one CLI round trip.

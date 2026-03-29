# Usage Scenarios

Browser Bridge is best when you need the state that already exists in a real Chrome tab: logged-in sessions, seeded storage, feature flags, SPA state, and whatever the page actually rendered.

If you need repeatable clean-room automation for tests or CI, use Playwright or another browser automation stack instead.

## 1. Debug a broken layout in the real page

Use this when the bug only reproduces in your current logged-in or feature-flag state.

Ask an MCP-capable agent:

> Use Browser Bridge MCP to inspect why the sidebar overlaps the main content.

Ask a CLI-skill agent:

> Use the browser-bridge skill to inspect the broken sidebar layout and tell me which computed styles are causing it.

Useful direct commands:

```bash
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
bbx click button[type="submit"]
bbx console error
bbx network 20
```

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

## 6. Drop to the raw protocol when shortcuts are not enough

Use this when you need a method or parameter that the higher-level commands do
not expose.

```bash
bbx call page.get_state
bbx call dom.query '{"selector":".card","maxNodes":10}'
bbx batch '[{"method":"page.get_state"},{"method":"page.get_console","params":{"level":"error"}}]'
```

For a command-oriented walkthrough, see [cli-guide.md](./cli-guide.md). For
integration choices, see [mcp-vs-cli.md](./mcp-vs-cli.md).

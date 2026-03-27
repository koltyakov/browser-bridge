# Access And Method Coverage

Browser Bridge no longer uses capability-scoped sessions.

The access model is:

1. The user turns Browser Bridge on for one browser window.
2. Default routing follows the active tab in that enabled window.
3. Use `tabId` only when you intentionally need a different tab in the same enabled window.
4. Turning Browser Bridge off removes access immediately.

## What Access Covers

Once a window is enabled, the bridge can use all standard methods in that window:

| Method Group | Examples |
|---|---|
| Inspect | `dom.query`, `dom.describe`, `styles.get_computed`, `layout.get_box_model` |
| Page state | `page.get_state`, `page.get_console`, `page.get_storage`, `page.get_text`, `page.get_network` |
| Interact | `input.click`, `input.type`, `input.hover`, `input.drag` |
| Navigate | `navigation.navigate`, `navigation.reload`, `viewport.scroll`, `viewport.resize` |
| Patch | `patch.apply_styles`, `patch.apply_dom`, `patch.rollback`, `patch.list` |
| Tabs | `tabs.list`, `tabs.create`, `tabs.close` |
| Debugger-backed | `page.evaluate`, `dom.get_accessibility_tree`, `screenshot.capture_*`, `cdp.*`, `performance.get_metrics` |

## Default Routing

Use default routing whenever possible:

```bash
bbx status
bbx page-text
bbx dom-query main
```

If the user switches to another tab in the enabled window, Browser Bridge follows that tab automatically.

## Explicit Tab Targeting

Use explicit `tabId` only for side-by-side comparisons or non-active tabs:

```bash
bbx tabs
bbx call --tab 123 page.get_text
bbx call --tab 456 dom.query '{"selector":"main"}'
```

In MCP tools, pass `tabId` for explicit targeting.

## Access Failures

If a call fails with `ACCESS_DENIED`, `TAB_MISMATCH`, or a routing error:

1. Confirm the user enabled Browser Bridge for the correct browser window.
2. Confirm the target page is a normal web page, not a Chrome-restricted page.
3. If using explicit `tabId`, confirm that tab is inside the enabled window.
4. Fall back to default routing when you do not need a specific tab.

# Capability Reference

Sessions are scoped by capabilities. The extension enforces them; any method call that exceeds the session's granted capabilities returns `CAPABILITY_MISSING`.

## Default Capabilities

All methods in the table below are included in the **default** capability set. You do not need to request them explicitly — `bbx request-access` grants them by default.

| Capability | Methods Unlocked |
|---|---|
| `page.read` | `page.get_state`, `page.get_console`, `page.get_storage`, `page.get_text`, `page.wait_for_load_state` |
| `page.evaluate` | `page.evaluate` |
| `dom.read` | `dom.query`, `dom.describe`, `dom.get_text`, `dom.get_attributes`, `dom.get_html`, `dom.wait_for`, `dom.find_by_text`, `dom.find_by_role`, `dom.get_accessibility_tree` |
| `styles.read` | `styles.get_computed`, `styles.get_matched_rules` |
| `layout.read` | `layout.get_box_model`, `layout.hit_test` |
| `viewport.control` | `viewport.scroll`, `viewport.resize` |
| `navigation.control` | `navigation.navigate`, `navigation.reload`, `navigation.go_back`, `navigation.go_forward` |
| `screenshot.partial` | `screenshot.capture_element`, `screenshot.capture_region` |
| `patch.dom` | `patch.apply_dom`, `patch.list`, `patch.rollback`, `patch.commit_session_baseline` |
| `patch.styles` | `patch.apply_styles` |
| `automation.input` | `input.click`, `input.focus`, `input.type`, `input.press_key`, `input.set_checked`, `input.select_option`, `input.hover`, `input.drag` |
| `cdp.dom_snapshot` | `cdp.get_document`, `cdp.get_dom_snapshot` |
| `cdp.box_model` | `cdp.get_box_model` |
| `cdp.styles` | `cdp.get_computed_styles_for_node` |
| `tabs.manage` | `tabs.list`, `tabs.create`, `tabs.close` |
| `performance.read` | `performance.get_metrics` |
| `network.read` | `page.get_network` |

## Requesting Capabilities Explicitly

When a task needs only a subset of permissions, narrowing the capability list is recommended. Request only what the task requires:

```bash
# Inspection-only session (no input, no patches, no navigation)
bbx call session.request_access '{"capabilities":["page.read","dom.read","styles.read","layout.read"]}'

# Read + patch session (no automation input, no navigation)
bbx call session.request_access '{"capabilities":["page.read","dom.read","styles.read","layout.read","patch.styles","patch.dom"]}'
```

In MCP mode via `browser_session`:
```json
{
  "action": "request_access",
  "capabilities": ["page.read", "dom.read", "styles.read", "layout.read"]
}
```

## Recovering from CAPABILITY_MISSING

If a call returns `CAPABILITY_MISSING`:

1. Note the capability name from the error details.
2. Call `session.get_status` (or `bbx session`) to see current session capabilities.
3. Revoke the current session with `bbx revoke`.
4. Call `request-access` again, adding the missing capability to those already granted.
5. Retry the original call.

```bash
# Example: network.read was missing
bbx revoke
bbx call session.request_access '{"capabilities":["page.read","dom.read","network.read"]}'
bbx network 20
```

## Checking Session Scope

```bash
bbx session                         # show current session and capabilities
bbx call session.get_status '{}'    # raw status including expiresAt
```

The session includes `expiresAt` (Unix ms). Sessions expire automatically; the CLI auto-refreshes on `SESSION_EXPIRED` errors.

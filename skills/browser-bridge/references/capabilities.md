# Access And Coverage Summary

Use this page only for the access model and routing rules.

The canonical per-method capability mapping now lives in [protocol.md](protocol.md), which includes a `Capability` column directly in the method table.

Browser Bridge does not use capability-scoped sessions anymore.

## Access Model

1. The user turns Browser Bridge on for one browser window.
2. With one connected profile, the first page call binds the session to its active tab. Later calls keep using that working tab even when browser focus changes.
3. Use `tabId` to choose a different working tab in the selected profile's enabled window.
4. Turning Browser Bridge off removes access immediately.

Once a window is enabled, the bridge can use all standard methods in that window, including debugger-backed methods when needed.

## Routing Defaults

Default routing is safe when only one browser profile is connected:

```bash
bbx status
bbx page-text
bbx dom-query main
```

If the user switches to another tab, Browser Bridge keeps using the session's working tab.

Use explicit `tabId` only for non-active tabs or deliberate side-by-side comparisons:

```bash
bbx tabs
bbx call --tab 123 page.get_text
bbx call --tab 456 dom.query '{"selector":"main"}'
```

With multiple profiles, first use `health.ping` to read `connectedExtensions` or an unscoped MCP `tabs.list` to find the requested page across enabled profiles. Pass the selected `extensionId` and `tabId` on every MCP call, plus `destinationId` for a remote machine. Profile-local tab IDs and element refs are not globally unique. For CLI, use `bbx call --extension <connectionId> --tab <tabId> <method> '{...}'`. Browser/profile names are also available through MCP `targetBrowser`/`targetProfile` or CLI `--browser`/`--profile` when they uniquely identify a connection.

Ambiguous calls fail before reaching a page with `TAB_MISMATCH`, `reason: ambiguous_browser_target`, and connection choices. Never disable unrelated windows to route a call. Connection IDs change on reconnect, so rediscover a missing target rather than silently switching profiles.

## Access Failures

If a call fails with `ACCESS_DENIED`, `TAB_MISMATCH`, or another routing error:

1. Confirm the user enabled Browser Bridge for the correct browser window.
2. Confirm the target page is a normal web page, not a Chrome-restricted page.
3. If using explicit `tabId`, confirm that tab is inside the enabled window.
4. For `ambiguous_browser_target`, choose a connection and list its tabs. Do not fall back to an unrelated active profile.

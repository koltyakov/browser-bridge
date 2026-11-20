# Access And Recovery

Load when access is denied by a setting, several browser profiles are connected, or an error needs per-code recovery.

## Access settings

The side panel can grant access to just one tab and control tab creation, user-tab closing, direct cross-domain navigation, and closing AI-created tabs when access ends. These settings take effect on new Bridge commands without reconnecting. Work already dispatched may finish. They are Bridge-command policies, not a browser-wide firewall for page scripts, link clicks, or redirects.

New tabs opened from an authorized tab inherit its tab-only access within the same window. This also applies to links opened from those new tabs. Unrelated tabs remain outside the grant, and linked user tabs are not AI-owned or automatically closed when access ends. Group membership alone never grants access.

`health.ping` returns `accessSettings.settings` and an opaque `accessSettings.settingsRevision`. Active sessions also receive updated settings on their next ordinary response. A denied policy operation returns `ACCESS_DENIED` with `details.reason=policy_setting_disabled`, `details.setting`, `details.settingsRevision`, the current settings, and `dispatched:false`. This is not a request to re-enable window access. Do not retry repeatedly or bypass the setting through another method.

Ask the user to enable the needed setting. After their confirmation, read health again, or issue one bounded read-only wait on the same destination and extensionId:

```bash
bbx call --extension '<extensionId>' access.wait_for_change '{"revision":"revision-from-error","timeoutMs":25000}'
```

In MCP, use `browser_call` with method `access.wait_for_change`, those params, and the same `extensionId`. The result returns as soon as the settings revision changes, or after the timeout with `changed:false`. Check the relevant setting, then deliberately retry only the operation rejected before dispatch and only while tab/window access remains granted. The wait never grants access, replays a request, or wakes an idle conversation. Stop rather than looping waits indefinitely.

## Multiple windows and profiles

Do not disable other windows or profiles to make routing work. `health.ping` returns `connectedExtensions`; its `access` status describes only the profile that answered. A restricted active tab there does not mean the requested page in another profile is unavailable.

In MCP, an unscoped `tabs.list` discovers tabs across enabled profiles. Choose the requested page by URL/title, then pass its `extensionId` and `tabId` on every call, including each batch item. Include `destinationId` for a remote machine. `tabId` and element refs are profile-local, so neither identifies a browser profile by itself. `targetBrowser` and `targetProfile` also work when their names uniquely identify a connection; prefer `extensionId` when labels are absent or duplicated.

Use the daemon connection's `extensionId`, not `browserExtensionId`, which identifies the installed Chrome extension and may be shared across profiles.

```json
{ "method": "page.get_state", "extensionId": "<connection ID from discovery>", "tabId": 123 }
```

CLI calls accept the same connection selector:

```bash
bbx call --extension '<connection ID from health.ping>' --tab 123 page.get_state '{}'
```

When multiple connections match, calls fail with `TAB_MISMATCH` and `reason: ambiguous_browser_target` before reading or changing any page. Choose a connection from the error's `connectedExtensions`, list its tabs, and retry with the exact target. Connection IDs change on reconnect; rediscover a missing connection rather than falling back to another profile. Ask the user to enable access only for the selected profile if it is disabled.

## Error recovery

Decide from the method, its parameters, execution evidence, and per-response
recovery, not the error code alone. `retry: false` forbids automatic retry;
`retry: true` is not permission to replay a mutation.

- **Safe reads** such as `health.ping`, `page.get_state`, `dom.query`, and scoped
  text/style reads may be retried once when recovery permits. Honor `retryAfterMs`
  and narrow an oversized or slow read. After a raw transport disconnect without
  recovery metadata, restore connectivity before retrying only a known-safe read.
  MCP already performs bounded recovery for eligible reads; do not stack retry
  loops around it or retry a canceled request.
- **Check parameters, not names.** Console/network reads with `clear: true` or
  capture start/stop change state. Arbitrary `page.evaluate` is not a safe read.
  `sensitive.read` and `webmcp.execute_tool` are never automatically retried.
- **Mutations** include input, navigation/reload/history, patches, uploads, and
  dialog actions. After timeout, internal error, cancellation, or lost connection,
  inspect partial progress and current application state before another deliberate
  action. Missing progress, `completed: 0`, `changed: false`, or failed observation
  does not prove that nothing executed. Never replay a sequence to recover a
  missing read or observation; failed sequences do not roll back completed steps.
- **Explicitly undispatched operations** may be deliberately retried after the
  blocker is resolved and current access/target checks pass. Require evidence
  covering the whole operation, such as `details.dispatched: false`, or
  `aftermath.dispatch: "not_started"` for an individual input. Do not infer this
  from an error code. Reconnection and debugger recovery restore transport or
  ownership, not permission to resume or replay input.

Local MCP errors without a confirmed bridge result return `retry: false` with
`details.outcomeUncertain: true` and no retry backoff. They cannot establish
dispatch state or completed-step counts. Inspect state rather than overriding
that uncertainty with the generic guidance below.

| Error                     | Retry?   | Recovery                                                                                  |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `ACCESS_DENIED`           | No automatic | Follow the access flow or policy-setting denial; do not bypass it. Deliberately retry only the undispatched operation after permission changes. |
| `ELEMENT_STALE`           | No       | Re-query with `dom.query` or `dom.find_by_text` to get a fresh ref                        |
| `ELEMENT_AMBIGUOUS`       | No       | Narrow the selector or use an explicit `elementRef`; do not guess                         |
| `ELEMENT_NOT_ACTIONABLE`  | No       | Inspect hidden/disabled/inert state with `dom.describe`                                   |
| `ELEMENT_OBSCURED`        | No       | Inspect bounded blocker details or use `layout.hit_test`                                  |
| `INPUT_FOCUS_CHANGED`     | No       | Inspect focus handlers; do not replay native text automatically                           |
| `DIALOG_NOT_OPEN`         | No       | Trigger or inspect the dialog again                                                       |
| `DIALOG_ACTION_CONFLICT`  | No       | Inspect current dialog state; never auto-repeat accept/dismiss                            |
| `TAB_MISMATCH`            | No       | For `ambiguous_browser_target`, select `extensionId` and list its tabs. For a closed working tab, select a new `tabId`. Never disable unrelated windows. |
| `TIMEOUT`                 | Safe reads only | When recovery permits, retry a narrower read once. For mutations, inspect progress and postconditions instead of repeating the action. |
| `CONTENT_SCRIPT_UNAVAILABLE` | No     | Switch to a normal http(s) page in the enabled window                                    |
| `EXTENSION_DISCONNECTED`  | Safe reads only | Check Chrome and `bbx status`; honor recovery backoff and rediscover the same target connection. Do not replay possibly dispatched actions. |
| `NATIVE_HOST_UNAVAILABLE` | No       | Run `bbx doctor` to diagnose the installation                                             |
| `INTERNAL_ERROR`          | Safe reads only | Retry a known-safe read once only if recovery permits. Local MCP uncertainty is non-retryable; inspect state and console evidence. |
| `DAEMON_OFFLINE`          | No       | Daemon not running - start with `bbx restart`                                             |
| `CONNECTION_LOST`         | Safe reads only | Reconnect and verify the same browser/profile/tab before one eligible read retry. A lost reply does not prove an action failed to execute. |
| `BRIDGE_TIMEOUT`          | Safe reads only | Simplify an eligible read. Inspect application state for mutations; do not repeat navigation or input to repair a timeout. |

Bridge errors include `error.recovery` with `retry`, optional `retryAfterMs`,
`alternativeMethod`, and `hint`; MCP structured results also expose `recovery`.
Use the specific response and execution evidence over code-level defaults.

`health.ping` is compact by default. Set `diagnostics: true` for build, debugger,
capture, baseline, transport, and recovery details. Routine pings still include
connectivity, compatibility, access readiness, and profile connection IDs.

`health.ping` with `diagnostics: true`, `daemon.metrics`, and `bbx doctor` expose process-local
five-minute recovery summaries for six fixed, content-free categories. Three
failures in the same hidden group within 60 seconds marks an active loop. Stop
repeating the action and follow Doctor's fixed category guidance. Extension
summaries reset on service-worker restart and daemon summaries on daemon restart;
they contain no page data, URLs, selectors, payloads, errors, or group names.

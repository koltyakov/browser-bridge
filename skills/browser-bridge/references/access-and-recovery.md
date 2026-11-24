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

CLI calls accept the same connection selector. `--browser` and `--profile` map to `targetBrowser` and `targetProfile` when those names uniquely identify a connection:

```bash
bbx call --extension '<connection ID from health.ping>' --tab 123 page.get_state '{}'
```

An explicit `tabId` must be inside the selected profile's enabled window.

When multiple connections match, calls fail with `TAB_MISMATCH` and `reason: ambiguous_browser_target` before reading or changing any page. Choose a connection from the error's `connectedExtensions`, list its tabs, and retry with the exact target. Connection IDs change on reconnect; rediscover a missing connection rather than falling back to another profile. Ask the user to enable access only for the selected profile if it is disabled.

## Access flow in detail

Browser Bridge access is window-scoped. The user turns it on once for the current browser window in the popup or side panel.

### Settings and profiles (summary)

The side panel can limit access to one tab and disable tab creation, user-tab closing, or cross-domain navigation. A denied policy returns `ACCESS_DENIED` with `details.reason=policy_setting_disabled` and `dispatched:false`: ask the user to change the setting instead of re-requesting access or bypassing it. With several profiles connected, pass the `extensionId` and `tabId` from `tabs.list` on every call; `TAB_MISMATCH` with `reason: ambiguous_browser_target` means pick one connection. Never disable unrelated windows to fix routing. Details: [access and recovery](#access-settings).

To request access, call `access.request` (via `bbx access-request`, `browser_access` MCP tool, or `bbx call access.request`). This surfaces an Enable cue in the extension popup/side panel for the focused window.

Do not call `access.request` repeatedly while the same window is still pending. If access is already requested, tell the user to enable that window and wait for them to confirm readiness.

If a tab-bound call fails with `ACCESS_DENIED` because Browser Bridge is off, that failed call also surfaces an enable cue automatically.

After the Enable cue appears:

1. Ask the user to open the Browser Bridge popup or side panel and click `Enable`.
2. After the user confirms, retry the call.

After access is enabled:

1. Your first tab-bound call binds your session to the active tab: that becomes your **working tab**.
2. The working tab is sticky. If the user switches to their own tab, keep running in your working tab without taking focus back. Reads, input, navigation, and screenshots can run in background tabs. A different `active_tab_id` is informational, not an error to fix.
3. Responses report `meta.tab_id`; when the user's active tab differs, the summary says so (`Ran in working tab 12; the user's active tab is 34`). If the user asks you to work in "this tab", pass that `tabId` once; the explicit tab becomes your new working tab. `tabs.create` and `tabs.activate` also move your working tab.
4. If your working tab was closed, calls fail with `TAB_MISMATCH` (`reason: working_tab_closed`) instead of silently using another tab; pick a tab with `tabId` or `tabs.list` (which marks `working: true`).
5. The binding expires after 15 idle minutes.
6. Do not stop at a generic "no access" message before making a real Browser Bridge call, because the first denied call is what triggers the UI cue.
7. CLI agents running separate `bbx` processes share one working tab unless each sets `BBX_SESSION=<name>`; MCP sessions are separated automatically.

### Tab focus

Switching to a tab you opened for the current task needs no new permission while the currently active tab is also one you are using for that task. Check `tabs.list` active state before switching. Track tabs you opened from your own `tabs.create` results; `working:true` identifies the routed tab, not ownership or foreground focus.

If the user has switched to their own tab, continue in the background. Activate only at their request or with their permission. If something cannot work while the target tab is inactive, explain why and ask whether you may activate it. A timeout alone does not establish that activation is needed. Permission for one activation does not allow repeatedly taking focus back after the user switches away.

These rules apply to `tabs.activate`, `active:true` on creation, and equivalent focus APIs. New tabs open in the background by default.

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
| `INPUT_VALUE_REJECTED`    | No       | Read `details.actual`; fill a value in `details.expectedFormat` or inspect the field mask  |
| `EVALUATION_FAILED` | No | Fix the expression; the page may have run part of it |
| `REQUEST_CANCELED` | No | Inspect postconditions before retrying a mutation |
| `BRIDGE_BUSY` | Yes | Retry after `retryAfterMs` |
| `DAEMON_UNAVAILABLE` | Yes | Retry once; then run `bbx doctor` |
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

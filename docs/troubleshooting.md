# Troubleshooting

For agent-led diagnosis and repair, give your agent the
[standalone troubleshooting skill](https://raw.githubusercontent.com/koltyakov/browser-bridge/main/docs/troubleshooting-skill.md).
It is URL-loadable, is not bundled with `bbx`, and includes a sanitized issue
template for unresolved problems.

When Browser Bridge is not working, start with local validation before blaming
the agent integration:

```bash
bbx doctor
bbx status
bbx restart
bbx tabs
bbx logs
```

`bbx doctor` diagnoses only the local bridge. Its report redacts page values,
expressions, secrets, tokens, and full payloads. Configured remotes are listed as
unverified and are not contacted; run `bbx remote test <name>` separately when a
remote destination is the problem.

Doctor also reports process-local recovery counters. They use six fixed
content-free categories and contain no page data, URLs, selectors, payloads,
error text, or internal method/tab groups.

## The extension is installed, but `bbx status` says it is disconnected

- Run `bbx install` again. It detects Browser Bridge in supported browsers and refreshes existing native registrations. Use `--browser <name>` for an explicit browser override or a nonstandard profile that detection cannot find.
- Run `bbx restart` to reload the local daemon and ask running Browser Bridge MCP servers to restart after updates.
- After upgrading from a version without coordinated MCP restart support, restart the agent once so its new MCP process can register for later `bbx restart` requests.
- Confirm the extension is enabled in Chrome.
- Use `bbx install <extension-id>` only for unpacked or custom extension builds.
- Restart Chrome after reinstalling the native messaging manifest if the host was missing when Chrome launched.
- On macOS or Linux, Chrome Beta, Dev, and Canary need their own native-host registrations. Run `bbx install`, or select the channel explicitly with `bbx install --browser chrome-canary`.
- If you start Chrome with `--user-data-dir`, register that directory with `bbx install --browser chrome --user-data-dir "/absolute/path/to/browser-data"`. Register the user-data root, not its `Default` subdirectory.
- If macOS reports `operation not permitted` for a browser directory, review the terminal or agent's macOS privacy permissions and complete the browser's first launch. Retry after granting the required access. Do not use `sudo` to work around per-user browser-data protection.
- On Ubuntu, the default Chromium package is usually a strict snap, and Flatpak Chromium is similarly sandboxed. If `bbx doctor` shows a sandboxed Chromium manifest and the extension still disconnects, use Google Chrome, Brave, or Edge from a non-sandboxed package and run `bbx install --browser <browser>`.

## The agent gets `ACCESS_DENIED`

- The first `ACCESS_DENIED` call automatically surfaces an Enable prompt in the extension UI.
- Alternatively, call `bbx access-request` (CLI) or use the `browser_access` MCP tool to trigger the prompt proactively.
- Open the Browser Bridge popup or side panel in Chrome and click Enable.
- Make sure the page you care about is in that enabled window, not a different Chrome window.

## The agent keeps using the wrong tab

- Browser Bridge defaults to the active tab in the enabled window.
- Bring the intended tab to the front, then retry.
- If your workflow needs a specific tab, target it explicitly through MCP parameters or `bbx call --tab <tabId> ...`.
- Use `bbx tabs` to confirm the tab ID and current active tab.

## The CLI works locally, but the agent cannot use it

- The agent may be running inside a sandboxed shell.
- Prefer MCP for Copilot and other sandboxed environments.
- If you intentionally want CLI mode, confirm the agent can execute `bbx` and read the installed Browser Bridge skill.

## `bbx install-skill` or `bbx install-mcp` wrote files, but the client still does not see Browser Bridge

- Restart the agent or client after writing config so it reloads MCP config or skill definitions.
- Check that you installed into the right scope: global vs project-local.
- For project-local installs, confirm the client is opened in the same repository where the config was written.
- For managed paths and examples, see [manual-setup.md](./manual-setup.md).

## The MCP server fails to start after upgrading to v2

For the full upgrade sequence, see [Migrate from v1 to v2](./migration-v1-to-v2.md).

- `bbx install`, which npm runs after a global upgrade, rewrites global MCP entries that still launch a removed v1 entrypoint such as `packages/mcp-server/src/bin.js` (written by v1 on Windows). It keeps the entry's environment and client-specific settings.
- `bbx doctor` warns about any other entry that launches a missing file. Rewrite it with `bbx install-mcp <client>`, then restart the client.
- Project-local configs are not scanned during upgrade; run `bbx install-mcp <client> --local` in that repository.
- If the install ran as another user, such as under `sudo`, files owned by your account are left unchanged. Run `bbx install` without `sudo`.

## Patches disappear

- Patch rollback history belongs to the current document, not a durable browser session.
- Navigation or reload replaces the document and invalidates old patch IDs.
- Disabling Browser Bridge or switching the enabled window triggers best-effort rollback of active patches.
- `patch.commit_session_baseline` intentionally keeps live changes while discarding rollback history; it does not write source.
- Use patches to prove the fix, then move the result into the codebase.

## Input fails or acts on no element

- `ELEMENT_NOT_FOUND` means no selector candidate matched.
- `ELEMENT_NOT_ACTIONABLE` reports hidden, disabled, inert, transparent, pointer-disabled, detached, or zero-size reasons.
- `ELEMENT_OBSCURED` includes a bounded blocker description; inspect it or use `layout.hit_test`.
- `ELEMENT_AMBIGUOUS` means candidates tied or exceeded the bounded 25-candidate resolver; narrow the selector or use a fresh explicit ref.
- `INPUT_FOCUS_CHANGED` means native text focus moved before dispatch. Inspect focus handlers; do not blindly replay text.
- Stale refs remain strict by default. Prefer re-querying; use `recoverStale: true` only for one same-document, unchanged-URL attempt with a strong unique descriptor. Recovery evaluates at most 100 same-tag candidates and returns `ELEMENT_AMBIGUOUS` with `reason: "scan_incomplete"` if additional candidates prevent proof of uniqueness.
- A successful dispatch does not prove app state changed. Verify with a wait or structured read.
- `RESULT_TRUNCATED` on a locator means the page was too large to prove a unique match within about two seconds (roughly 200,000 elements). Add a container-scoped `selector`, such as `form input`, or use a ref from a scoped read.

## Dialog handling reports a conflict or no dialog

- Dialog actions are explicit and debugger-backed; Browser Bridge never auto-accepts or auto-dismisses.
- Input and evaluation calls watch for native dialogs and return non-retryable `DIALOG_BLOCKED` instead of waiting for the blocked page. `input.perform` stops even with `continueOnError: true`. Inspect with `page.handle_dialog`, then explicitly accept or dismiss. The original operation may already have taken effect and may finish after dismissal; inspect postconditions instead of replaying it. Observed dialogs keep their debugger connection until they close or access is cleared.
- `DIALOG_NOT_OPEN` means no current dialog was observable, including when attachment missed an earlier dialog lifecycle.
- `DIALOG_ACTION_CONFLICT` means the observed dialog changed around the command. Inspect again and do not automatically repeat accept/dismiss.
- `expectedDialogId` is checked immediately before dispatch, but Chrome cannot atomically bind its dialog command to that ID.

## Chrome shows the debugging banner in disabled windows

- Chrome owns this security banner and shows it globally when an extension uses `chrome.debugger`. Extensions cannot limit it to enabled windows. The banner does not mean Browser Bridge is controlling disabled windows.
- A tab's debugger session stays attached until the tab has had no debugger work for 60 seconds, so the banner stays up while an agent works instead of appearing and disappearing between steps. Screenshot artifact uploads do not keep the debugger busy.
- All input modes use the debugger to observe native dialogs, even when events are dispatched through the DOM: Chrome reports a dialog only to a debugger that was attached when it opened. Open dialogs retain observation until closed. Explicit CDP capture and request interception keep the debugger attached until stopped or cleared.
- Chrome can keep the banner visible briefly after the last debugger detaches. Avoid debugger-backed operations when ordinary DOM, style, console, or default fetch/XHR reads answer the question.
- To isolate the banner from normal browsing, use a separate Chrome instance with its own user-data directory. Another window or profile in the same Chrome instance is not sufficient.

## Pages in other windows scroll or jump while an agent works

- When the debugging banner appears or disappears, every window in the Chrome instance, in every profile, loses or regains the banner's height. Pages that respond to a viewport resize can react. For example, YouTube Shorts snaps to the next or previous video, so it looks as if someone pressed the arrow keys.
- Browser Bridge keeps debugger sessions attached through pauses between agent steps, so the banner usually changes only when an agent starts and some time after it stops.
- To remove the banner entirely, quit Chrome completely and start it with `--silent-debugger-extension-api`. On macOS, run `open -a "Google Chrome" --args --silent-debugger-extension-api` while Chrome is not running. On Windows, add the flag to the end of the Chrome shortcut's Target. The flag applies to the whole Chrome instance and hides the banner for every extension that uses `chrome.debugger`, so you no longer get Chrome's warning that an extension is debugging your pages.
- Alternatively, keep resize-sensitive pages, such as video feeds, in a separate Chrome instance with its own user-data directory, or in another browser.

## Screenshots of background tabs are slow or time out

- On Windows and Linux, Chrome sometimes never answers `Page.captureScreenshot` for a hidden tab; a single attempt left waiting 30 s still did not finish. macOS was not affected in testing. How often it happens depends on the Chrome session: one Windows session stalled on a few percent of captures, another on most captures after the first few in each tab. Disabling renderer backgrounding or `captureBeyondViewport` did not change this. Chrome rejects `fromSurface: false` ("Only screenshots from surface are allowed"), and `chrome.tabs.captureVisibleTab` needs the tab in front.
- BBX makes up to three attempts, bounded at 0.5 s, 1 s, and 5 s plus time for large images. A stalled attempt releases the tab's debugger session, and the next attempt starts on a fresh one, which usually succeeds.
- If every attempt stalls, the call fails with `TIMEOUT` after about 6.5 s. The MCP server does not retry it automatically, and later debugger-backed calls on that tab still work. Prefer structured reads, or capture while the tab is in front.

## CDP network capture or HAR export is empty or still armed

- Default `page.get_network` captures only fetch/XHR. Use `source: "cdp"` for broader resource metadata.
- Run `capture: "start"` before reproducing; a later read is not retrospective.
- HAR requires the capture to remain armed. Use start, reproduce, `bbx har` or `network.export_har`, then stop. Export never starts, stops, or clears capture.
- Read lifecycle fields such as `armed`, `captureState`, `ownershipHeld`, `inflight`, `dropped`, and `abandoned` before assuming capture was complete.
- Inflight requests are unfinished and absent from the HAR. `dropped` means retained evidence was lost to bounds; `abandoned` records unfinished activity discarded by lifecycle or bounds.
- Always run `capture: "stop"` when finished. If debugger detaches or conflicts with DevTools, close the competing debugger and retry the start/reproduce/read/stop sequence.
- CDP URLs redact credentials, fragments, and query values. Bodies, cookies, authorization values, and complete headers are intentionally unavailable.
- HAR URLs retain hosts, paths, and query names. Unsupported byte sizes and timing phases are `-1`; redirects, failures, cache, and service-worker observations remain metadata only.
- If an artifact expired, was deleted, or was requested from another client, rerun the capture/export. Handles last five minutes, are owner-scoped, and expose no browser-host path.

## Doctor reports an active recovery loop

- Recovery uses five-second buckets over the last five minutes. An active loop means three failures in the same hidden group occurred within 60 seconds.
- Stop repeating the failing action. `bbx doctor` supplies fixed guidance for stale refs, debugger reattachment, content-script reinjection, native-host reconnect, automatic MCP retry, or general request outcomes.
- Re-query stale refs; close competing debuggers; reload the extension/page for reinjection failures; use `bbx restart` for reconnect failures; inspect the first typed error before retrying request failures.
- The loop clears after failures age out of the 60-second window. Extension-side telemetry resets on service-worker restart and daemon-side telemetry resets on daemon restart, so it is not durable incident history.

## What to include in a bug report

- Output summary from `bbx status`
- Output summary from `bbx doctor`
- `bbx tabs` for routing context
- `bbx logs` if the bridge is failing after connection
- Whether you are using MCP or the CLI skill

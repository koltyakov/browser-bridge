# Troubleshooting

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

## The extension is installed, but `bbx status` says it is disconnected

- Run `bbx install` again. It targets Chromium on Linux and Chrome on macOS/Windows; for another browser, include `--browser <name>`.
- Run `bbx restart` to reload the local daemon and ask running Browser Bridge MCP servers to restart after updates.
- After upgrading from a version without coordinated MCP restart support, restart the agent once so its new MCP process can register for later `bbx restart` requests.
- Confirm the extension is enabled in Chrome.
- Use `bbx install <extension-id>` only for unpacked or custom extension builds.
- Restart Chrome after reinstalling the native messaging manifest if the host was missing when Chrome launched.
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

## Dialog handling reports a conflict or no dialog

- Dialog actions are explicit and debugger-backed; Browser Bridge never auto-accepts or auto-dismisses.
- `DIALOG_NOT_OPEN` means no current dialog was observable, including when attachment missed an earlier dialog lifecycle.
- `DIALOG_ACTION_CONFLICT` means the observed dialog changed around the command. Inspect again and do not automatically repeat accept/dismiss.
- `expectedDialogId` is checked immediately before dispatch, but Chrome cannot atomically bind its dialog command to that ID.

## CDP network capture is empty or still armed

- Default `page.get_network` captures only fetch/XHR. Use `source: "cdp"` for broader resource metadata.
- Run `capture: "start"` before reproducing; a later read is not retrospective.
- Read lifecycle fields such as `armed`, `captureState`, `ownershipHeld`, `inflight`, `dropped`, and `abandoned` before assuming capture was complete.
- Always run `capture: "stop"` when finished. If debugger detaches or conflicts with DevTools, close the competing debugger and retry the start/reproduce/read/stop sequence.
- CDP URLs redact credentials, fragments, and query values. Bodies, cookies, authorization values, and complete headers are intentionally unavailable.

## What to include in a bug report

- Output summary from `bbx status`
- Output summary from `bbx doctor`
- `bbx tabs` for routing context
- `bbx logs` if the bridge is failing after connection
- Whether you are using MCP or the CLI skill

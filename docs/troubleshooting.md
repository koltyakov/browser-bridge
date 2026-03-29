# Troubleshooting

When Browser Bridge is not working, start with local validation before blaming
the agent integration:

```bash
bbx status
bbx doctor
bbx tabs
bbx logs
```

## The extension is installed, but `bbx status` says it is disconnected

- Run `bbx install` again.
- Confirm the extension is enabled in Chrome.
- If you are using a published store build that still needs an explicit ID, run `bbx install <extension-id>`.
- Restart Chrome after reinstalling the native messaging manifest if the host was missing when Chrome launched.

## The agent gets `ACCESS_DENIED`

- Open the Browser Bridge popup or side panel in Chrome.
- Enable Browser Bridge for the current browser window.
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

- Restart the client after writing config.
- Check that you installed into the right scope: global vs project-local.
- For project-local installs, confirm the client is opened in the same repository where the config was written.
- For managed paths and examples, see [manual-setup.md](./manual-setup.md).

## Patches disappear

- Patches are session-scoped, not permanent source changes.
- Navigation, reloads, or session resets can invalidate them.
- Use patches to prove the fix, then move the result into the codebase.

## What to include in a bug report

- Output summary from `bbx status`
- Output summary from `bbx doctor`
- `bbx tabs` for routing context
- `bbx logs` if the bridge is failing after connection
- Whether you are using MCP or the CLI skill

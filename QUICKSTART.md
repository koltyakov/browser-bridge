# Browser Bridge Quick Start

This guide is for people using Browser Bridge from another repo while the extension and package are still unpublished.

## Prerequisites

Before setup, the user machine needs:

- Google Chrome installed
- Node.js and npm installed on the machine running Browser Bridge
- A local checkout of this Browser Bridge repo in a stable path
- A local checkout of the app repo where `bbx ...` will be used
- A locally running coding agent or IDE integration if you want Browser Bridge to work from that tool

The app repo can use any stack that serves or generates web pages.
It does not need to be a Node.js project and does not need a `package.json`.

Browser Bridge depends on a local Chrome instance and a local native host.
Remote-only agents do not work with it.
For example, GitHub Copilot coding agent on GitHub.com cannot use Browser Bridge.

## 1. Install Browser Bridge once

Pick one stable checkout location for this repo and keep it there.

```bash
cd /absolute/path/to/browser-bridge
npm install
npm link
```

`npm link` makes `bbx`, `bbx-daemon`, and `bbx-install` available from any repo on your machine.

If you move this checkout later, rerun `npm link` and `bbx install <extension-id>`.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this repo root.
5. Copy the extension ID.
6. On the page you want to inspect, open the Browser Bridge popup or side panel and enable agent communication for that tab.

This is the temporary setup until the extension is published.

## 3. Use `bbx` from any repo

After `npm link`, you can run Browser Bridge commands from your app repo or any other shell:

```bash
bbx status
```

Do not add Browser Bridge to the consumer repo as a path-based dependency.
That would write a machine-specific absolute path that will not work on another user's machine.

## 4. Install the local native host

From your app repo, or any other terminal on the same machine:

```bash
bbx install <extension-id>
```

Optional check:

```bash
bbx status
```

If the daemon is offline, start it once:

```bash
bbx-daemon
```

## 5. Install or update the skill

From your app repo:

```bash
bbx install-skill
```

That installs the Browser Bridge skill into the standard skill locations:

- `.github/skills/browser-bridge/`
- `.claude/skills/browser-bridge/`
- `.opencode/skills/browser-bridge/`
- `.agents/skills/browser-bridge/`

It does not modify `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md`.

To install only some targets:

```bash
bbx install-skill copilot,claude
```

If you are not currently in the target repo:

```bash
bbx install-skill --project /absolute/path/to/your-app
```

To update later, rerun the same command.

## 6. Verify from your app repo

From the repo you are actually coding in:

```bash
bbx status
bbx tabs
bbx request-access
```

If `request-access` returns `APPROVAL_PENDING` or `ACCESS_DENIED`, enable the tab in the extension UI and retry.

## 7. Agent-specific commands

`bbx install-skill` installs skills only. Any repo instructions stay user-owned.

If your agent asks for command approval, allow `bbx` and `bbx-daemon` for that repo.
During the initial Browser Bridge setup, you may also need to allow `npm` and `node`.

### Codex

No Browser Bridge-specific skill install target yet.

### GitHub Copilot

`bbx install-skill copilot`

Copilot can also read `AGENTS.md` and `.github/copilot-instructions.md`, but `install-skill` does not write either file.

Use Copilot locally, in the IDE or CLI. Do not rely on the GitHub.com coding agent for Browser Bridge, because that agent runs in a remote sandbox and cannot reach your local Chrome instance or native host.

### Cursor

No documented native project skill install target yet.

### OpenCode

`bbx install-skill opencode`

### Claude Code

`bbx install-skill claude`

## 8. After updates

- If you pull changes into your Browser Bridge checkout, rerun `npm install` there when dependencies change.
- Rerun `bbx install-skill` in repos where you want the latest skill files.
- If the Browser Bridge checkout path changes, rerun `npm link` and `bbx install <extension-id>` from the new path.

## Troubleshooting

- `DAEMON_OFFLINE`: run `bbx-daemon`
- `APPROVAL_PENDING` or `ACCESS_DENIED`: enable the tab in the extension UI, then rerun `bbx request-access`
- `NATIVE_HOST_UNAVAILABLE`: rerun `bbx install <extension-id>` from your stable Browser Bridge checkout

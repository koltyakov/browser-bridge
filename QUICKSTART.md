# Browser Bridge Quick Start

This guide is for people using Browser Bridge from another repo while the extension and package are still unpublished.

## Prerequisites

Before setup, the user machine needs:

- Google Chrome installed
- Node.js and npm installed
- A local checkout of this Browser Bridge repo in a stable path
- A local checkout of the app repo where `npx bb ...` will be used
- A locally running coding agent or IDE integration if you want Browser Bridge to work from that tool

Browser Bridge depends on a local Chrome instance and a local native host.
Remote-only agents do not work with it.
For example, GitHub Copilot coding agent on GitHub.com cannot use Browser Bridge.

## 1. Install Browser Bridge once

Pick one stable checkout location for this repo and keep it there.

```bash
cd /absolute/path/to/browser-bridge
npm install
```

If you move this checkout later, rerun `npx bb install <extension-id>`.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this repo root.
5. Copy the extension ID.
6. On the page you want to inspect, open the Browser Bridge popup or side panel and enable agent communication for that tab.

This is the temporary setup until the extension is published.

## 3. Make `npx bb` work inside your own repo

In every project repo where you want to use Browser Bridge:

```bash
cd /absolute/path/to/your-app
npm install --save-dev /absolute/path/to/browser-bridge
```

That adds `bb` to the repo-local `node_modules/.bin`, so `npx bb ...` works from that repo even before the package is published.

## 4. Install the local native host

From your app repo:

```bash
npx bb install <extension-id>
```

Optional check:

```bash
npx bb status
```

If the daemon is offline, start it once:

```bash
npx bb-daemon
```

## 5. Install or update the skill

From your app repo:

```bash
npx bb install-skill
```

That installs the Browser Bridge skill into the standard skill locations:

- `.github/skills/browser-bridge/`
- `.claude/skills/browser-bridge/`
- `.opencode/skills/browser-bridge/`
- `.agents/skills/browser-bridge/`

It does not modify `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md`.

To install only some targets:

```bash
npx bb install-skill copilot,claude
```

To update later, rerun the same command.

## 6. Verify from your app repo

From the repo you are actually coding in:

```bash
npx bb status
npx bb tabs
npx bb request-access
```

If `request-access` returns `APPROVAL_PENDING` or `ACCESS_DENIED`, enable the tab in the extension UI and retry.

## 7. Agent-specific commands

`npx bb install-skill` installs skills only. Any repo instructions stay user-owned.

If your agent asks for command approval, allow `npm`, `node`, `npx bb`, and `npx bb-daemon` for that repo.

### Codex

No Browser Bridge-specific skill install target yet.

### GitHub Copilot

`npx bb install-skill copilot`

Copilot can also read `AGENTS.md` and `.github/copilot-instructions.md`, but `install-skill` does not write either file.

Use Copilot locally, in the IDE or CLI. Do not rely on the GitHub.com coding agent for Browser Bridge, because that agent runs in a remote sandbox and cannot reach your local Chrome instance or native host.

### Cursor

No documented native project skill install target yet.

### OpenCode

`npx bb install-skill opencode`

### Claude Code

`npx bb install-skill claude`

## 8. After updates

- If you pull changes into your Browser Bridge checkout, rerun `npm install --save-dev /absolute/path/to/browser-bridge` in any consumer repos that should pick up the update.
- Rerun `npx bb install-skill` in repos where you want the latest skill files.
- If the Browser Bridge checkout path changes, rerun `npx bb install <extension-id>` from the new path.

## Troubleshooting

- `DAEMON_OFFLINE`: run `npx bb-daemon`
- `APPROVAL_PENDING` or `ACCESS_DENIED`: enable the tab in the extension UI, then rerun `npx bb request-access`
- `NATIVE_HOST_UNAVAILABLE`: rerun `npx bb install <extension-id>` from your stable Browser Bridge checkout

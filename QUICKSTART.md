# Browser Bridge Quick Start

Browser Bridge helps coding agents debug real web apps in the real browser tab you already have open.

The primary path is:

1. Load the Browser Bridge extension
2. Install the CLI: `npm install -g @browserbridge/bbx`
3. Install the native host: `bbx install <extension-id>`
4. Verify readiness: `bbx doctor`
5. Choose either MCP mode or skill/CLI mode

Browser Bridge depends on a local Chrome instance and a local native host. Remote-only agents do not work with it.

## Prerequisites

- Google Chrome installed
- Node.js and npm installed on the same machine as Chrome
- A local coding agent or IDE integration if you want Browser Bridge available inside that tool

The app repo can use any stack. It does not need to be a Node.js project.

## 1. Install the CLI

```bash
npm install -g @browserbridge/bbx
```

That exposes `bbx`, `bbx-mcp`, `bbx-daemon`, and `bbx-install`.

## 2. Install the extension

### Repo-development path

Browser Bridge currently ships the extension from this repository. Clone it, install dependencies, then load it unpacked:

```bash
git clone <repo-url> /absolute/path/to/browser-bridge
cd /absolute/path/to/browser-bridge
npm install
```

Then load the extension from `chrome://extensions` with **Load unpacked** and select the repo root.

## 3. Install the native host

If you already have `BROWSER_BRIDGE_EXTENSION_ID` set in your shell environment:

```bash
bbx install
```

For the current unpacked/dev extension flow, pass the extension ID from `chrome://extensions`:

```bash
bbx install <extension-id>
```

`bbx install` also accepts a full `chrome-extension://<id>/` origin and normalizes it to the extension ID.

Then verify:

```bash
bbx doctor
bbx status
```

If the daemon is offline, start it once:

```bash
bbx-daemon
```

## 4. Approve a tab

1. Open the page you want the agent to inspect.
2. Open the Browser Bridge popup or side panel.
3. Enable agent communication for that tab.
4. In a terminal, run:

```bash
bbx request-access
```

If `request-access` returns `APPROVAL_PENDING` or `ACCESS_DENIED`, enable the tab in the extension UI and retry.

## 5. Pick an integration mode

### MCP mode

Print a ready-to-paste MCP config snippet:

```bash
bbx mcp config claude
bbx mcp config cursor
bbx mcp config vscode
```

Generic MCP JSON:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "bbx",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
```

Some clients expect `mcpServers`, while others use a different top-level key such as `servers` or also allow `"type": "stdio"`. If your client is strict, use `bbx mcp config <client>` to print the exact shape it expects.

The MCP server command is:

```bash
bbx mcp serve
```

You can also use the dedicated bin directly:

```bash
bbx-mcp
```

### Skill and CLI mode

Install the Browser Bridge skill into a repo:

```bash
bbx install-skill
```

Supported targets:

- `copilot`
- `claude`
- `opencode`
- `agents`
- `codex`
- `openai`

Examples:

```bash
bbx install-skill codex
bbx install-skill claude
bbx install-skill copilot,openai
bbx install-skill --project /absolute/path/to/your-app
```

`install-skill` copies the managed Browser Bridge skill into project-local skill locations and does not modify `AGENTS.md`, `CLAUDE.md`, or `.github/copilot-instructions.md`.

## 6. Basic verification

From the repo you are actually coding in:

```bash
bbx doctor
bbx status
bbx tabs
bbx request-access
bbx dom-query main
bbx styles main display,gap
```

## Agent Notes

### Codex and OpenAI tools

Use:

```bash
bbx install-skill codex
```

That installs the managed skill under `.codex/skills/browser-bridge/`.

### GitHub Copilot

Use Copilot locally in the IDE or CLI. Do not rely on the GitHub.com coding agent for Browser Bridge because that agent runs in a remote sandbox and cannot reach your local Chrome instance or native host.

## Troubleshooting

- `bbx doctor` is the fastest way to see whether the manifest, daemon, extension, and session are ready.
- `DAEMON_OFFLINE`: run `bbx-daemon`
- `APPROVAL_PENDING` or `ACCESS_DENIED`: enable the tab in the extension UI, then rerun `bbx request-access`
- `NATIVE_HOST_UNAVAILABLE`: rerun `bbx install <extension-id>` or set `BROWSER_BRIDGE_EXTENSION_ID` and rerun `bbx install`

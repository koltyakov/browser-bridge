# Manual Setup

Use this guide when the side panel setup flow is not enough, when you want
project-local config instead of global config, or when you are wiring Browser
Bridge into a custom agent.

## Prerequisites

- Google Chrome on the same machine as the agent
- Node.js 18 or newer
- The Browser Bridge extension installed in Chrome

## 1. Install the CLI and native host

```bash
npm install -g @browserbridge/bbx
bbx install
```

`bbx install` writes the native messaging manifest so the extension can talk to
the local host. If you are connecting a packaged store build before the
installer embeds a default extension ID, use `bbx install <extension-id>`.

## 2. Verify the local bridge first

Run these before involving an agent:

```bash
bbx status
bbx doctor
```

Then open Chrome, enable Browser Bridge for the current window, and verify tab
routing:

```bash
bbx tabs
bbx call page.get_state
```

If these commands do not work locally, the agent setup will not work either.

## 3. Managed setup for supported clients

Supported managed targets are kept in this order across the project:
`codex`, `claude`, `cursor`, `copilot`, `opencode`, `antigravity`,
`windsurf`, `agents`.

### MCP setup

Use MCP when your agent supports it:

```bash
bbx install-mcp
bbx install-mcp codex
bbx install-mcp copilot --local
```

Managed MCP config paths:

- `codex`: `~/.codex/config.toml` or `./.codex/config.toml`
- `claude`: `~/.claude.json` or `./.mcp.json`
- `cursor`: `~/.cursor/mcp.json` or `./.cursor/mcp.json`
- `copilot`: `~/.copilot/mcp-config.json` or `./.vscode/mcp.json`
- `opencode`: `~/.config/opencode/opencode.json` or `./opencode.json`
- `antigravity`: `~/.gemini/antigravity/mcp_config.json` or `./.gemini/antigravity/mcp_config.json`
- `windsurf`: `~/.codeium/windsurf/mcp_config.json` or `./.windsurf/mcp_config.json`

### CLI skill setup

Use the CLI skill when you want the agent to invoke `bbx` directly:

```bash
bbx install-skill
bbx install-skill codex
bbx install-skill agents --project .
```

Managed skill paths:

- `codex`: `~/.codex/skills/browser-bridge` or `./.codex/skills/browser-bridge`
- `claude`: `~/.claude/skills/browser-bridge` or `./.claude/skills/browser-bridge`
- `cursor`: `~/.cursor/skills/browser-bridge` or `./.cursor/skills/browser-bridge`
- `copilot`: `~/.copilot/skills/browser-bridge` or `./.github/skills/browser-bridge`
- `opencode`: `~/.opencode/skills/browser-bridge` or `./.opencode/skills/browser-bridge`
- `antigravity`: `~/.gemini/antigravity/skills/browser-bridge` or `./.agents/skills/browser-bridge`
- `windsurf`: `~/.codeium/windsurf/skills/browser-bridge` or `./.windsurf/skills/browser-bridge`
- `agents`: `~/.agents/skills/browser-bridge` or `./.agents/skills/browser-bridge`

## 4. Custom-agent MCP wiring

If your client supports MCP but is not one of the managed targets above, it
must be able to launch:

```bash
bbx mcp serve
```

Most JSON-based MCP clients use a config block like this:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "type": "stdio",
      "command": "bbx",
      "args": ["mcp", "serve"],
      "env": {}
    }
  }
}
```

Two common exceptions:

- Codex uses TOML with `[mcp_servers."browser-bridge"]`
- OpenCode uses an `"mcp"` block with `"type": "local"` and a command array

## 5. Custom-agent CLI skill wiring

For generic agent runners that load skills from a project directory:

```bash
bbx install-skill agents --project .
```

That writes the Browser Bridge skill into `./.agents/skills/browser-bridge`.
Your agent still needs shell access to run `bbx`.

## 6. Recommended validation flow

After wiring the agent, validate the smallest useful path:

1. Ask the agent to check Browser Bridge status.
2. Ask it to read page state from the current tab.
3. Ask it to query one visible element.
4. Ask it to read one computed style or console entry.

If that works, the rest of the bridge surface is usually available too.

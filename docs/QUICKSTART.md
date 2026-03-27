# Browser Bridge Quick Start

Browser Bridge lets your coding agent inspect and patch the real Chrome tab you already have open - DOM, styles, console, network, and more - without screenshots or raw HTML dumps.

> **Requires:** Google Chrome and Node.js on the same machine as your agent. Remote-only agents (e.g. GitHub.com Copilot) cannot reach a local Chrome instance.

## 1. Install the extension

Install [Browser Bridge from the Chrome Web Store](https://chrome.google.com/webstore/detail/ahhmghheecmambjebhfjkngdggghbkno). <!-- TODO: replace with final store link after publishing -->

## 2. Install the CLI

```bash
npm install -g @browserbridge/bbx
```

This also installs the native messaging host automatically.

## 3. Connect your agent

There are two integration paths. Pick the one that matches how your agent works:

Supported clients: `codex` (OpenAI Codex), `claude` (Claude Code), `cursor` (Cursor), `copilot` (GitHub Copilot), `opencode` (OpenCode), `antigravity` (Antigravity), `windsurf` (Windsurf).

After installing the extension and CLI, finish the rest from the extension side panel's **Host Setup** section, or use the `bbx install-mcp` / `bbx install-skill` commands below if you prefer terminal setup.

> **Recommendation:** MCP and the CLI skill are not meant to be installed together by default. Prefer MCP when your agent supports it. If CLI mode is unreliable because the agent runs in a sandboxed shell, such as GitHub Copilot, use MCP instead.

**MCP** - recommended for agents with native MCP tool support, and the best fallback when CLI mode is blocked by sandboxing. Write the config directly into each client's settings file:

```bash
bbx install-mcp                  # all supported clients
bbx install-mcp codex            # or pick one: codex, claude, cursor, copilot, opencode, antigravity, windsurf
bbx install-mcp copilot --local  # scope to current project instead of global
```

Configs are written globally by default. For GitHub Copilot, that means `~/.copilot/mcp-config.json`; project installs still use `.vscode/mcp.json`. Browser Bridge also writes the older VS Code `User/mcp.json` locations as compatibility fallbacks.

**Skill + CLI** - for agents that can reliably run shell commands and where you want direct `bbx` control. Install the Browser Bridge skill so your agent knows how to drive `bbx`:

```bash
bbx install-skill                  # all supported clients
bbx install-skill codex            # or pick one: codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents
bbx install-skill copilot --local  # scope to current project instead of global
```

The Browser Bridge skill is a CLI path. Use `bbx install-skill` for shell-driven agent flows and generic agent runtimes.

Shortcut commands cover the common cases. Advanced protocol fields stay available through `bbx call <method> '{...}'` when you need the full bridge surface, and exact bridge methods can also be invoked directly for the raw path, for example `bbx page.get_state`.

> The paths are independent. MCP clients use MCP tools; CLI skill clients use `bbx`. You do not need both, and most users should start with MCP if it is available.

## 4. Enable a tab

1. Open the page you want your agent to inspect.
2. Click the Browser Bridge toolbar icon or open the side panel.
3. If needed, finish MCP or CLI skill setup from **Host Setup**.
4. Enable agent communication for that tab.

Your agent can now inspect and patch that tab through Browser Bridge.

## 5. Use it

**MCP mode** - tools are auto-discovered by the client. Just ask naturally:

You can refer to it as `BB MCP` or `Browser Bridge MCP`; both should work.

> *"Why is the sidebar layout broken on this page?"*
> *"Use BB MCP to inspect why the sidebar layout is broken."*
> *"Check the CSS on the hero section and fix the spacing."*
> *"Does my latest change actually render correctly in the browser?"*

**Skill + CLI mode** - reference the skill explicitly so the agent knows to use `bbx`:

> *"Use the browser-bridge skill to check why the sidebar layout is broken."*
> *"Using browser-bridge skill, verify the hero section spacing and fix it."*

For GitHub Copilot, invoke the skill by name, for example `/browser-bridge`.
`bbx` is the Browser Bridge CLI command, not a guaranteed Copilot skill alias.

In both cases the agent reads live DOM, styles, console, and network state from your real tab. Patches are reversible and session-scoped - the agent verifies the fix in the browser before writing it back to source.

## 6. Ad-Hoc installation

### Installing MCP for custom agent

For custom agents or clients not listed above, you can manually configure MCP if your agent supports the [Model Context Protocol](https://modelcontextprotocol.io/clients).

Most MCP clients use a `mcpServers` (or `mcp_servers`) key in their configuration:

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

Some clients use different configuration keys or formats:
- **OpenCode** uses `"mcp"` with `"type": "local"` and a command array
- **Codex** uses TOML format with `[mcp_servers."browser-bridge"]`

Check your agent's documentation for the exact configuration location and format. The key requirement is that your agent must be able to launch the Browser Bridge MCP server via `bbx mcp serve`.

### Installing skills for a custom agent

For custom agents that use CLI skills instead of MCP, you can install the Browser Bridge skill to a location your agent expects:

```bash
bbx install-skill --local
```

This installs the Browser Bridge skill to the `.agents/skills/` directory in your current project. Custom agents can then reference the skill from this location.

Some agents may expect skills in different locations:
- **Generic agents** typically look in `.agents/skills/`
- **Project-specific setups** can use `--local` to install to the current project
- **Global installations** can omit `--local` to install to `~/.agents/skills/`

The skill includes a `SKILL.md` file that agents can read to understand how to use Browser Bridge commands. Your agent must be able to execute shell commands and read skill documentation to make use of this integration.

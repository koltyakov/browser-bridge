# Browser Bridge Quick Start

Browser Bridge lets your coding agent inspect and patch the real Chrome tab you already have open - DOM, styles, console, network, and more - without screenshots or raw HTML dumps.

> **Requires:** Google Chrome and Node.js on the same machine as your agent. Remote-only agents (e.g. GitHub.com Copilot) cannot reach a local Chrome instance.

## 1. Install the extension

Install [Browser Bridge from the Chrome Web Store](https://chrome.google.com/webstore/detail/niaidbpnkbfbjgdfieabpmlomilpdipn). <!-- TODO: replace with final store link after publishing -->

## 2. Install the CLI

```bash
npm install -g @browserbridge/bbx
```

This also installs the native messaging host automatically.

## 3. Connect your agent

There are two integration paths - pick the one that fits how your agent works:

Supported clients: `copilot` (GitHub Copilot / VS Code), `codex` (OpenAI Codex CLI), `cursor` (Cursor), `claude` (Claude Desktop / Claude Code).

**MCP** - for agents with native MCP tool support. Write the config directly into each client's settings file:

```bash
bbx install-mcp                  # all supported clients
bbx install-mcp copilot          # or pick one: copilot, codex, cursor, claude
bbx install-mcp copilot --local  # scope to current project instead of global
```

Configs are written globally by default. MCP is better with `$bbx-mcp` skill that teaches your agent to call methods directly for more structured, token-efficient output. No manual `bbx` calls needed.

**Skill + CLI** - for agents that run shell commands. Install the Browser Bridge skill so your agent knows how to drive `bbx`:

```bash
bbx install-skill                  # all supported clients
bbx install-skill copilot          # or pick one: copilot, codex, claude, opencode, agents
bbx install-skill copilot --local  # scope to current project instead of global
```

Skills are installed globally by default. The skill teaches your agent to call `bbx` commands directly for structured, token-efficient browser output. No MCP wiring needed.

Shortcut commands cover the common cases. Advanced protocol fields stay available through `bbx call <method> '{...}'` when you need the full bridge surface.

> Both paths can be used together - MCP for tool calls, skill for usage guidance.

## 4. Enable a tab

1. Open the page you want your agent to inspect.
2. Click the Browser Bridge toolbar icon or open the side panel.
3. Enable agent communication for that tab.

Your agent can now inspect and patch that tab over MCP.

## 5. Use it

**MCP mode** - tools are auto-discovered by the client. Just ask naturally:

> *"Why is the sidebar layout broken on this page?"*
> *"Check the CSS on the hero section and fix the spacing."*
> *"Does my latest change actually render correctly in the browser?"*

**Skill + CLI mode** - reference the skill explicitly so the agent knows to use `bbx`:

> *"Using $bbx skill, check why the sidebar layout is broken."*
> *"Using browser-bridge skill, verify the hero section spacing and fix it."*

In both cases the agent reads live DOM, styles, console, and network state from your real tab. Patches are reversible and session-scoped - the agent verifies the fix in the browser before writing it back to source.

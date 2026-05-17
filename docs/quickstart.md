# Quickstart

Browser Bridge lets your coding agent inspect and patch the real Chrome or Chromium-based browser tab you already have open - DOM, styles, console, network, and more - without screenshots or raw HTML dumps.

> **Requires:** Google Chrome or a supported Chromium-based browser, plus Node.js on the same machine as your agent. Remote-only agents (e.g. GitHub.com Copilot) cannot reach a local browser instance.
>
> **Privacy:** Browser Bridge itself sends extension data locally to the companion host and connected local client. Your chosen agent or IDE may still forward tool results onward under its own policy. See [`PRIVACY.md`](../PRIVACY.md).

## 1. Install the extension

Install [Browser Bridge from the Chrome Web Store](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie).

## 2. Install the CLI

```bash
npm install -g @browserbridge/bbx
```

This also installs the native messaging host automatically.

If the extension does not connect itself during setup, run:

```bash
bbx install
```

`bbx install` targets Chromium on Linux and Chrome on macOS/Windows. To install the native messaging manifest for a different browser, pass `--browser`:

```bash
bbx install --browser chrome    # Google Chrome
bbx install --browser edge      # Microsoft Edge
bbx install --browser brave     # Brave
bbx install --browser chromium  # Chromium
bbx install --browser arc       # Arc
bbx install --all               # All supported browsers
```

On Ubuntu, the default Chromium package is usually a strict snap, and Flatpak
Chromium is similarly sandboxed. If Chromium still reports the extension as
disconnected after install, use a non-sandboxed Chromium-based browser such as
Google Chrome, Brave, or Edge and install the manifest for that browser.

## 3. Connect your agent

There are two integration paths. Pick the one that matches how your agent works:

Supported clients: `codex` (OpenAI Codex), `claude` (Claude Code), `cursor` (Cursor), `copilot` (GitHub Copilot), `opencode` (OpenCode), `antigravity` (Antigravity), `windsurf` (Windsurf), `agents` (generic `.agents` MCP/skill layout).

After installing the extension and CLI, finish the rest from the extension side panel's **Host Setup** section, or use the `bbx install-mcp` / `bbx install-skill` commands below if you prefer terminal setup. With no target argument, the CLI prompts in interactive shells; in non-interactive shells it prefers already configured or detected clients before falling back to all supported clients.

> **Recommendation:** MCP and the CLI skill are not meant to be installed together by default. If your agent supports both, start with MCP. The bridge protocol and browser data are the same either way; the difference is integration style. MCP fits agent tool systems better because it is structured, validated, and does not depend on shell access. Choose the CLI skill when you specifically want direct `bbx` control for shell-driven workflows such as setup, debugging, scripting, or raw protocol calls. If CLI mode is unreliable because the agent runs in a sandboxed shell, such as GitHub Copilot, use MCP instead.

**MCP** - the default path for agents with native MCP tool support. Prefer this when your agent can use either mode. It gives the agent structured tools, server instructions, and MCP prompt templates without relying on shell execution, and it is the best fallback when CLI mode is blocked by sandboxing. Write the config directly into each client's settings file:

```bash
bbx install-mcp                  # prompt/select detected clients
bbx install-mcp all              # all supported clients
bbx install-mcp codex            # or pick one: codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents
bbx install-mcp copilot --local  # scope to current project instead of global
```

Configs are written globally by default. For GitHub Copilot, that means `~/.copilot/mcp-config.json`; project installs still use `.vscode/mcp.json`. Browser Bridge also writes the older VS Code `User/mcp.json` locations as compatibility fallbacks.

The MCP server is self-contained: clients can discover Browser Bridge tools, startup instructions, and prompts such as `browser_bridge_guide`, `browser_bridge_investigate`, `browser_bridge_debug_layout`, and `browser_bridge_verify_flow`. You do not need the CLI skill for MCP guidance.

**Skill + CLI** - for agents that can reliably run shell commands and where direct `bbx` control is the better fit than MCP tools. Use this path for shell-driven agent flows, setup and doctor flows, scripting, logs, or raw protocol access. Install the Browser Bridge skill so your agent knows how to drive `bbx`:

```bash
bbx install-skill                  # prompt/select detected clients
bbx install-skill all              # all supported clients
bbx install-skill codex            # or pick one: codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents
bbx install-skill agents --project .
```

The Browser Bridge skill is a CLI path. Use `bbx install-skill` for shell-driven agent flows and generic agent runtimes.

Shortcut commands cover the common cases. Advanced protocol fields stay available through `bbx call <method> '{...}'` when you need the full bridge surface, and exact bridge methods can also be invoked directly for the raw path, for example `bbx page.get_state`.

If Browser Bridge does not appear immediately after `bbx install-mcp` or `bbx install-skill`, restart the agent so it reloads MCP config or skill definitions.

> The paths are independent. MCP clients use MCP tools; CLI skill clients use `bbx`. You do not need both. For normal agent use, start with MCP if it is available; choose the CLI skill when shell-native control is the point.

## 4. Enable a window

1. Open the page you want your agent to inspect.
2. Click the Browser Bridge toolbar icon or open the side panel.
3. If needed, finish MCP or CLI skill setup from **Host Setup**.
4. Enable agent communication for the current Chrome window.

Your agent can now inspect and patch the active tab in that enabled window, or other tabs in the same window when explicitly targeted.

## 5. Use it

**MCP mode** - tools are auto-discovered by the client. Just ask naturally:

You can refer to it as `BB MCP` or `Browser Bridge MCP`; both should work.

> _"Why is the sidebar layout broken on this page?"_
> _"Use BB MCP to inspect why the sidebar layout is broken."_
> _"Check the CSS on the hero section and fix the spacing."_
> _"Does my latest change actually render correctly in the browser?"_

**Skill + CLI mode** - reference the skill explicitly so the agent knows to use `bbx`:

> _"Use the browser-bridge skill to check why the sidebar layout is broken."_
> _"Using browser-bridge skill, verify the hero section spacing and fix it."_

For GitHub Copilot, invoke the skill by name, for example `/browser-bridge`.
`bbx` is the Browser Bridge CLI command, not a guaranteed Copilot skill alias.

In both cases the agent reads live DOM, styles, console, and network state from your real tab. Patches are reversible and session-scoped. When visual confirmation is still needed after structured reads, prefer a partial element screenshot or a tight region crop instead of a larger page capture before writing the fix back to source.

For open-ended inspection in MCP mode, start with `browser_investigate`. It is read-only and intended to be delegated to a smaller, lower-cost subagent when the client supports delegation. The CLI-skill equivalent is to start with `bbx batch` or `bbx call` using `page.get_state`, `dom.query`, and `page.get_text` before escalating to screenshots.

## 6. Need more detail?

Use the focused guides instead of stretching quickstart into a manual:

- [Documentation index](./index.md)
- [Manual setup](./manual-setup.md) for custom agents, exact config locations, and project-local installs
- [Usage scenarios](./usage-scenarios.md) for concrete debugging and patching workflows
- [CLI guide](./cli-guide.md) for command-oriented usage
- [MCP vs CLI](./mcp-vs-cli.md) if you are deciding between integration paths
- [Troubleshooting](./troubleshooting.md) when setup or access fails

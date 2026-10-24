# Quickstart

Browser Bridge lets your coding agent inspect and patch the real Chrome or Chromium-based browser tab you already have open - DOM, styles, console, network, and more - without screenshots or raw HTML dumps.

> **Requires:** Google Chrome and Browser Bridge on your computer. Install through npm with Node.js 20 or later, or use a standalone binary without Node.js. Remote-only agents need an explicitly configured remote connection.
>
> **Privacy:** The extension and native host communicate on the browser machine, and local clients are the default. Explicitly configured authenticated remote destinations can carry results over your own tunnel or network route. Your chosen agent or IDE may also forward tool results under its own policy. See [`PRIVACY.md`](../PRIVACY.md).

## 1. Install the extension

Install [Browser Bridge from the Chrome Web Store](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie).

## 2. Install Browser Bridge

With npm, using Node.js 20 or later:

```bash
npm install -g @browserbridge/bbx
```

The npm package is a bootstrap and launcher with zero runtime npm dependencies. It downloads the Go executable for the exact installed package version and your platform from GitHub Releases, verifies its pinned SHA-256 digest, then registers the native messaging host for a global install. Supported platforms are macOS arm64/x64, Linux arm64/x64, and Windows x64.

Alternatively, [download a standalone binary](https://github.com/koltyakov/browser-bridge/releases/latest) and follow the [manual installation steps](./native-cli.md#install-without-nodejs). This path does not require Node.js or npm.

A local dependency install downloads the executable without registering a browser. If npm install scripts were skipped, the first `bbx` command downloads it; run `bbx install` to register the native host. Source checkouts skip this bootstrap during development. See the [native CLI guide](./native-cli.md).

Update an npm-managed installation with:

```bash
npm install -g @browserbridge/bbx@latest
```

Each npm version pins its own native release assets. Upgrade with `npm install -g @browserbridge/bbx@<version>` or `npm install -g @browserbridge/bbx@latest`. `bbx update status` identifies npm-managed installations. The separate native signed updater does not override npm's version selection.

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

Supported clients: Codex (OpenAI) (`codex`), Claude Code (`claude`), OpenCode (`opencode`), GitHub Copilot (`copilot`), Cursor (`cursor`), Devin Desktop, formerly Windsurf (`windsurf`), Antigravity (`antigravity`), Gemini CLI (`gemini`), Cline (`cline`), Zed (`zed`), Amp (`amp`), Factory Droid (`droid`), Pi (`pi`), Kilo Code (`kilo`), Qwen Code (`qwen`), Goose (`goose`), OpenHands (`openhands`), Muse Code (`muse`), Grok Build (`grok`), and generic `.agents` MCP/skill layouts (`agents`).

Cline, Goose, OpenHands, and Muse MCP configuration is user-scope only; their CLI skills support projects too. Zed support configures the native agent, not every ACP agent it can host. Gemini CLI is a separate target from Antigravity. Grok means official Grok Build, not a community wrapper. See [manual setup](./manual-setup.md#3-managed-setup-for-supported-clients) for paths, overrides, and shared-skill behavior.

Devin Desktop retains the `windsurf` setup target and existing configuration paths for compatibility:

```bash
bbx install-mcp windsurf
bbx install-skill windsurf
```

After installing the extension and Browser Bridge, finish setup from **Connect agent** in the extension side panel. Terminal users can use `bbx install-mcp` / `bbx install-skill` below. With no target argument, the CLI prompts in interactive shells; in non-interactive shells it prefers already configured or detected clients before falling back to all supported clients.

> **Recommendation:** MCP and the CLI skill are not meant to be installed together by default. If your agent supports both, start with MCP. The bridge protocol and browser data are the same either way; the difference is integration style. MCP fits agent tool systems better because it is structured, validated, and does not depend on shell access. Choose the CLI skill when you specifically want direct `bbx` control for shell-driven workflows such as setup, debugging, scripting, or raw protocol calls. If CLI mode is unreliable because the agent runs in a sandboxed shell, such as GitHub Copilot, use MCP instead.

**MCP** - the default path for agents with native MCP tool support. Prefer this when your agent can use either mode. It gives the agent structured tools and server instructions without relying on shell execution, and it is the best fallback when CLI mode is blocked by sandboxing. Write the config directly into each client's settings file:

```bash
bbx install-mcp                  # prompt/select detected clients
bbx install-mcp all              # all supported clients
bbx install-mcp codex            # Pick a supported target listed above
bbx install-mcp pi,kilo,qwen,goose,openhands,muse,grok
bbx install-mcp copilot --local  # scope to current project instead of global
```

Configs are written globally by default. For GitHub Copilot, that means `~/.copilot/mcp-config.json`; project installs still use `.vscode/mcp.json`. Browser Bridge also writes the older VS Code `User/mcp.json` locations as compatibility fallbacks.

The MCP server is self-contained: clients can discover Browser Bridge tools and startup instructions. Workflow guidance is delivered to agents through the server instructions rather than MCP prompt templates, so clients do not expose it as user-facing slash commands. You do not need the CLI skill for MCP guidance.

Permission prompts are client-owned and MCP instructions cannot grant permissions by themselves. In permission-ask hosts, Browser Bridge tells the agent to use the generic `browser_call` MCP tool by default so the user can approve one BBX tool instead of separate `browser_status`, `browser_page`, `browser_dom`, `browser_input`, and patch tools. See [Agent permissions](./agent-permissions.md) for wildcard/server-wide allow rules by client.

The same stdio command supports both MCP protocol eras. Legacy clients start with six common tools and can load a specialized typed tool through `browser_toolset`. Modern stateless clients receive a fixed six-tool surface with `browser_skill` in place of `browser_toolset`, because modern tool lists cannot change as a side effect of another request. `browser_call` reaches every bridge method in both eras, and method `protocol.describe` loads method or group parameters without adding another tool schema. See [MCP vs CLI](./mcp-vs-cli.md#tool-discovery-by-protocol-era) for details.

**Skill + CLI** - for agents that can reliably run shell commands and where direct `bbx` control is the better fit than MCP tools. Use this path for shell-driven agent flows, setup and doctor flows, scripting, logs, or raw protocol access. Install the Browser Bridge skill so your agent knows how to drive `bbx`:

```bash
bbx install-skill                  # prompt/select detected clients
bbx install-skill all              # all supported clients
bbx install-skill codex            # Pick a supported target listed above
bbx install-skill pi,kilo,qwen,goose,openhands,muse,grok --local
bbx install-skill agents --project .
```

The Browser Bridge skill is a CLI path. Use `bbx install-skill` for shell-driven agent flows and generic agent runtimes.

Activity keeps the same CLI/MCP tags. Hover a tag to see the calling client and version when known. MCP uses the client's reported identity; CLI calls recognize active OpenCode, Claude Code, Codex, Cursor, and Gemini CLI environment markers. If markers are missing or conflicting, set `BBX_AGENT=opencode` or another client name in the calling process's environment. This is display-only attribution, not authentication. Marker values and model identities are not collected.

Shortcut commands cover the common cases. Advanced protocol fields stay available through `bbx call <method> '{...}'` when you need the full bridge surface, and exact bridge methods can also be invoked directly for the raw path, for example `bbx page.get_state`.

If Browser Bridge does not appear immediately after `bbx install-mcp` or `bbx install-skill`, restart the agent so it reloads MCP config or skill definitions.

> The paths are independent. MCP clients use MCP tools; CLI skill clients use `bbx`. You do not need both. For normal agent use, start with MCP if it is available; choose the CLI skill when shell-native control is the point.

## 4. Enable a window

1. Open the page you want your agent to inspect.
2. Click the Browser Bridge toolbar icon or open the side panel.
3. If needed, finish MCP or CLI skill setup from **Connect your agent**.
4. Enable agent communication for the current Chrome window.

Your agent can now inspect and patch the active tab in that enabled window, or other tabs in the same window when explicitly targeted.

The side panel shows an **other enabled windows** counter beside the window access heading when access is also enabled elsewhere. Open it to see the browser, session profile label, and window details. It includes other browsers and profiles connected to the same local daemon, not separate daemons or machines. Each browser profile allows one enabled window at a time.

Click an entry to focus its existing browser window, restoring it if minimized. This does not launch a browser or rebind an agent's working tab. **Disable all** in the dropdown header revokes access in all other listed windows, including other browsers and profiles. The side panel's current window stays unchanged. The dropdown reports failures instead of claiming that every window was disabled.

Agents do not need to disable other windows to choose a target. In MCP, `tabs.list` discovers tabs across enabled profiles. Reuse the selected tab's `extensionId` and `tabId` on each call, plus `destinationId` when remote. `health.ping` also lists connection IDs in `connectedExtensions`; its access status describes only the profile that answered. CLI users can target a connection with `bbx call --extension <connectionId> --tab <tabId> page.get_state '{}'`. Calls matching multiple profiles fail before touching any page. Rediscover connection IDs after a reconnect.

Restart the daemon and reload the extension in each browser after updating. Older connected extensions still count when enabled, but their window details or focus and disable controls may be unavailable.

Tabs with agent activity are marked with blue **AI** groups. Adjacent active tabs share a group;
separated tabs use separate groups to preserve tab order. Pinned tabs and existing groups are
left alone. Browser Bridge removes its groups after 15 idle minutes or when access is disabled.

## 5. Use it

**MCP mode** - tools are auto-discovered by the client. Just ask naturally:

You can refer to it as `BB MCP` or `Browser Bridge MCP`; both should work.

> _"Why is the sidebar layout broken on this page?"_
> _"Use BBX MCP to inspect why the sidebar layout is broken."_
> _"Check the CSS on the hero section and fix the spacing."_
> _"Does my latest change actually render correctly in the browser?"_

**Skill + CLI mode** - reference the skill explicitly so the agent knows to use `bbx`:

> _"Use the browser-bridge skill to check why the sidebar layout is broken."_
> _"Using browser-bridge skill, verify the hero section spacing and fix it."_

For GitHub Copilot, invoke the skill by name, for example `/browser-bridge`.
`bbx` is the Browser Bridge CLI command, not a guaranteed Copilot skill alias.

In both cases the agent reads live DOM, styles, console, and network state from your real tab. Targeted input actions report how the target was resolved and whether DOM or optional native CDP dispatch was used; `cdp_press_key` and `scroll_into_view` use separate response contracts. The agent should still verify the application outcome with a wait or structured read. Patches keep rollback history in the current document, and Browser Bridge attempts best-effort rollback when access is disabled or switched while the document remains available. When visual confirmation is still needed after structured reads, prefer a partial element screenshot or a tight region crop instead of a larger page capture before writing the fix back to source.

For open-ended inspection in MCP mode, start with `browser_investigate`. It is read-only and intended to be delegated to a smaller, lower-cost subagent when the client supports delegation. For explicit parallel MCP reads use `browser_batch`; `batch` is not a valid method for `browser_call`. The CLI-skill equivalent is to start with `bbx batch` or `bbx call` using `page.get_state`, `dom.query`, and `page.get_text` before escalating to screenshots.

## 6. Need more detail?

Use the focused guides instead of stretching quickstart into a manual:

## Remote VM / private network

Remote browser access is opt-in. Enable loopback proxy mode on the machine that has Chrome and the Browser Bridge extension:

```bash
bbx proxy enable --port 9223
```

The command prints a token and an SSH local-forward command. On your dev machine, open the tunnel, save the token in a private file, and register the tunnel endpoint:

```bash
ssh -N -L 9223:127.0.0.1:9223 user@browser-machine
# In another shell:
bbx remote add remote-bbx 127.0.0.1:9223 --token-file <token-file>
```

Port `9223` is used by default when omitted. The SSH tunnel is recommended because Browser Bridge
raw TCP is unencrypted. Direct non-loopback binding is available only with an explicit
`--unsafe-plaintext` acknowledgement; see the remote proxy guide.

Your local MCP server still talks to the local browser by default. Discovery tools such as `browser_status` and `browser_tabs` list local and remote destinations; pass `destinationId`, for example `vm-private`, to route a specific MCP call to the remote browser. On the CLI, add `--remote <name>` to any bridge command (or set `BBX_REMOTE=<name>` for the whole session).

See the [Remote proxy guide](./remote-proxy.md) for the full flow, security notes, and troubleshooting.

- [Documentation index](./index.md)
- [Manual setup](./manual-setup.md) for custom agents, exact config locations, and project-local installs
- [Usage scenarios](./usage-scenarios.md) for concrete debugging and patching workflows
- [CLI guide](./cli-guide.md) for command-oriented usage
- [MCP vs CLI](./mcp-vs-cli.md) if you are deciding between integration paths
- [Troubleshooting](./troubleshooting.md) when setup or access fails

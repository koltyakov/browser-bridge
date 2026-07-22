# Browser Bridge (BBX)

![Browser Bridge (BBX): Connect AI Agent and Browsers](https://raw.githubusercontent.com/koltyakov/browser-bridge/main/assets/banner.jpg)

> **Chrome Web Store:** Install `Browser Bridge (BBX)` from the [Chrome Web Store](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie). For local or custom builds, use the unpacked install flow in [docs/unpacked-extension.md](https://github.com/koltyakov/browser-bridge/blob/main/docs/unpacked-extension.md).

A local bridge between your coding agent and a real Chrome tab. Browser Bridge gives the agent structured access to DOM, styles, layout, console, network, accessibility data, reliable browser input, explicit JavaScript dialog handling, and reversible patches - starting from the actual tab you already have open, with all its real state intact.

See [Quickstart](https://github.com/koltyakov/browser-bridge/blob/main/docs/quickstart.md) to get started in another repo, or browse the rest of the guides in [docs/index.md](https://github.com/koltyakov/browser-bridge/blob/main/docs/index.md).

## Supported Agents

Managed installs support OpenAI Codex, Claude Code, Cursor, GitHub Copilot, OpenCode, Antigravity, Windsurf, and generic `.agents` layouts for both MCP and CLI skill setup.

<table align="center">
  <tr>
    <td align="center" width="140">
      <a href="https://openai.com/codex/">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/codex.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/codex.png" alt="OpenAI Codex" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
    <td align="center" width="140">
      <a href="https://claude.com/product/claude-code">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/claude.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/claude.png" alt="Claude Code" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
    <td align="center" width="140">
      <a href="https://cursor.com/">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/cursor.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/cursor.png" alt="Cursor" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
    <td align="center" width="140">
      <a href="https://github.com/features/copilot">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/githubcopilot.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/githubcopilot.png" alt="GitHub Copilot" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
  </tr>
  <tr>
    <td align="center">OpenAI Codex</td>
    <td align="center">Claude Code</td>
    <td align="center">Cursor</td>
    <td align="center">GitHub Copilot</td>
  </tr>
  <tr>
    <td align="center" width="140">
      <a href="https://opencode.ai/">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/opencode.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/opencode.png" alt="OpenCode" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
    <td align="center" width="140">
      <a href="https://antigravity.google/">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/antigravity.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/antigravity.png" alt="Antigravity" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
    <td align="center" width="140">
      <a href="https://windsurf.com/">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="https://unpkg.com/@lobehub/icons-static-png@latest/dark/windsurf.png" />
          <img src="https://unpkg.com/@lobehub/icons-static-png@latest/light/windsurf.png" alt="Windsurf" style="width: 44px; height: 44px; object-fit: contain;" />
        </picture>
      </a>
    </td>
    <td align="center" width="140">
      <code>.agents</code>
    </td>
  </tr>
  <tr>
    <td align="center">OpenCode</td>
    <td align="center">Antigravity</td>
    <td align="center">Windsurf</td>
    <td align="center">Generic agents</td>
  </tr>
</table>

## What it's for

- Debugging a UI on `localhost`: read DOM, computed styles, layout, console logs, and network state without a screenshot
- Verifying a code change actually rendered the expected result in Chrome
- Patching the live page to prove a fix visually, then moving it into source and rolling the patch back
- Running structured browser checks from any local agent or IDE, not just one AI product

## Why Browser Bridge

Most adjacent tools optimize for different goals. [Playwright](https://playwright.dev/) and headless automation stacks are excellent for deterministic tests and CI - but they start from a clean browser context by design. [Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) is great for integrated Claude workflows, and the [Codex extension](https://chromewebstore.google.com/detail/codex/hehggadaopoacecdllhhajmbjkdcmajg) is a great option if you use Codex, but both are vendor-specific. Generic MCP browser servers offer broad control without the developer-focused depth.

Browser Bridge is optimized for the opposite starting point: **inspect the state that already exists** in a real tab - logged-in sessions, feature flags, seeded storage, SPA state - use structured reads to understand it, test a patch in place, then fix the source. It's open-source, agent-agnostic, and scoped to one explicitly enabled browser window rather than ambient browser control.

## Setup

1. Install [Browser Bridge from the Chrome Web Store](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie) in Chrome or another Chromium-based browser
2. `npm install -g @browserbridge/bbx` - installs the CLI and native host
3. Run `bbx install` (Chromium on Linux, Chrome elsewhere), or target a specific browser with `bbx install --browser chrome`, `bbx install --browser edge`, `bbx install --browser brave`, `bbx install --browser chromium`, or `bbx install --browser arc`
4. In the extension side panel, install MCP or CLI (skill) for your agent of choice
5. Enable Browser Bridge for the browser window you want to inspect/control with the AI agent
6. Ask your agent to use Browser Bridge via MCP (`BB MCP` or `Browser Bridge MCP`), or invoke the installed Browser Bridge skill in CLI mode (`/browser-bridge`, `browser-bridge`, or the client-specific skill trigger)

On Ubuntu, Chromium is commonly installed as a strict snap, and Flatpak Chromium is similarly sandboxed. If native messaging stays disconnected there, use a non-sandboxed Chromium-based browser such as Google Chrome, Brave, or Edge.

MCP mode is self-contained: the server exposes tools and startup instructions, so a separate CLI skill is not required for MCP guidance.

## How it works

- The extension is scoped to one explicitly enabled Chrome window at a time - no ambient browser access
- Requests default to the active tab in that window unless a tab is targeted explicitly
- Targeted input actions reject hidden, disabled, ambiguous, stale, or obscured targets instead of silently guessing; their responses report the resolution and DOM/CDP execution path (`cdp_press_key` and `scroll_into_view` use separate contracts)
- Native pointer/text input, dialog handling, all-resource network capture, accessibility trees, screenshots, and raw CDP reads use the existing debugger permission only when requested
- Element references are document-local and strict by default; stale input recovery is opt-in, same-document, requires one strong unique semantic match, and fails safely when its bounded scan cannot prove uniqueness
- Patches keep per-document rollback history and Browser Bridge attempts best-effort rollback when window access is disabled or switched; committing the patch baseline keeps current changes but discards their rollback history
- URL waits observe full navigation and same-document SPA changes, and report the final URL and observed navigation kind
- Structured DOM/style/layout reads are the primary transport; screenshots are a fallback
- Browser input dispatch does not prove the application accepted the intended change, so agents should verify with a wait or structured read
- Open-ended investigation should start with structured reads on a smaller, lower-cost subagent when the client supports delegation
- The native host daemon auto-starts on demand

## Documentation

- [Quickstart](https://github.com/koltyakov/browser-bridge/blob/main/docs/quickstart.md)
- [Usage scenarios](https://github.com/koltyakov/browser-bridge/blob/main/docs/usage-scenarios.md)
- [Manual setup](https://github.com/koltyakov/browser-bridge/blob/main/docs/manual-setup.md)
- [Agent permissions](https://github.com/koltyakov/browser-bridge/blob/main/docs/agent-permissions.md)
- [CLI guide](https://github.com/koltyakov/browser-bridge/blob/main/docs/cli-guide.md)
- [MCP vs CLI](https://github.com/koltyakov/browser-bridge/blob/main/docs/mcp-vs-cli.md)
- [Troubleshooting](https://github.com/koltyakov/browser-bridge/blob/main/docs/troubleshooting.md)
- [BridgeClient API](https://github.com/koltyakov/browser-bridge/blob/main/docs/api-reference.md)

## Privacy

The extension and native host communicate on the browser machine, and local clients connect to that daemon by default. If you explicitly configure an authenticated remote destination, bridge results can travel over your user-provided SSH tunnel or network route to the selected client. Browser Bridge does not operate a Browser Bridge cloud service, and raw remote TCP is not presented as encrypted.

Your connected agent or IDE may still forward tool calls or tool results to remote services under that product's own settings and privacy policy. See [PRIVACY.md](https://github.com/koltyakov/browser-bridge/blob/main/PRIVACY.md) for the Browser Bridge policy.

## Responsible Use

Browser Bridge is intended for local development, debugging, and testing of web resources you own, control, or are explicitly authorized to test. Do not use it for web scraping, unauthorized data collection, or impersonating or acting as another user. You are responsible for the agents you connect, the actions they perform, and compliance with applicable laws, permissions, website terms, and third-party rights. See the [Responsible Use Agreement](https://github.com/koltyakov/browser-bridge/blob/main/RESPONSIBLE_USE.md).

## License

MIT. See [LICENSE](https://github.com/koltyakov/browser-bridge/blob/main/LICENSE).

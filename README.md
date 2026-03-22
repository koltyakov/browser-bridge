# Browser Bridge

<p align="center">
  <img src="./assets/logo.png" alt="Browser Bridge logo" width="220" />
</p>

A local bridge between your coding agent and a real Chrome tab. Browser Bridge gives the agent structured access to DOM, styles, layout, console, network, and reversible patches - starting from the actual tab you already have open, with all its real state intact.

See [QUICKSTART.md](QUICKSTART.md) to get started in another repo.

## What it's for

- Debugging a UI on `localhost`: read DOM, computed styles, layout, console logs, and network state without a screenshot
- Verifying a code change actually rendered the expected result in Chrome
- Patching the live page to prove a fix visually, then moving it into source and rolling the patch back
- Running structured browser checks from any local agent or IDE, not just one AI product

## Why Browser Bridge

Most adjacent tools optimize for different goals. [Playwright](https://playwright.dev/) and headless automation stacks are excellent for deterministic tests and CI - but they start from a clean browser context by design. [Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) is great for integrated Claude workflows, but is vendor-specific. Generic MCP browser servers offer broad control without the developer-focused depth.

Browser Bridge is optimized for the opposite starting point: **inspect the state that already exists** in a real tab - logged-in sessions, feature flags, seeded storage, SPA state - use structured reads to understand it, test a patch in place, then fix the source. It's open-source, agent-agnostic, and scoped to explicit tab sessions rather than ambient browser control.

## Setup

1. Install [Browser Bridge from the Chrome Web Store](https://chrome.google.com/webstore/detail/niaidbpnkbfbjgdfieabpmlomilpdipn) <!-- TODO: replace with final store link after publishing -->
2. `npm install -g @browserbridge/bbx` - installs the CLI and native host
3. `bbx install-mcp` - connect your agent via MCP
4. `bbx install-skill` - install skill+CLI
5. Enable extension session in side panel
6. Ask your agent to use Browser Bridge (`$bbx` skill or MCP)


## How it works

- The extension is scoped to explicitly enabled tabs only - no ambient browser access
- Sessions are tab and origin scoped, auto-refreshed when possible
- All patch operations are reversible and session-scoped
- Structured DOM/style/layout reads are the primary transport; screenshots are a fallback
- The native host daemon auto-starts on demand

## License

MIT. See [LICENSE](LICENSE).

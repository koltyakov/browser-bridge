# Project Guide

## Overview

- `Browser Bridge` is a Chrome extension plus local Native Messaging bridge for token-efficient, scoped browser inspection and patching.
- Main areas:
  - `packages/extension`: MV3 extension runtime, content script, popup, side panel, offscreen cropper
  - `packages/native-host`: local daemon, native host bootstrap, manifest installer
  - `packages/protocol`: shared protocol shapes, normalization, error codes, budgeting
  - `packages/agent-client`: CLI (`bbx`) and subagent-facing bridge client
  - `packages/mcp-server`: MCP stdio server exposing Browser Bridge tools
  - `skills/browser-bridge`: modular skill - core SKILL.md loaded first, reference docs on demand

## CLI Quick Reference

```bash
bbx status                          # bridge health
bbx doctor                          # install/access readiness
bbx install [extension-id]          # install native manifest
bbx call <method> '{"key":"val"}'   # any RPC method
bbx batch '[{...}]'                 # parallel reads
bbx install-mcp [client]            # write MCP config (all clients if omitted)
bbx skill                           # runtime presets
```

Also: `bbx-daemon` (start daemon), `bbx-install <ext-id>` (install manifest directly), `bbx-mcp` (start MCP server directly).

For agent debugging inside this repo, prefer `npx bbx ...` when a user asks to use the browser-bridge skill or `bbx` commands so the workspace CLI is exercised directly. Keep end-user documentation, the shipped skill, and consumer-facing guidance using `bbx`, `bbx-daemon`, and `bbx-install` as globally installed commands.

## Skill Structure

- `skills/browser-bridge/SKILL.md` - core rules, quick reference, access flow (always loaded)
- `skills/browser-bridge/references/protocol.md` - full method table, error codes (load when exploring methods)
- `skills/browser-bridge/references/token-efficiency.md` - budget presets, anti-patterns (load when optimizing)
- `skills/browser-bridge/references/patch-workflow.md` - style/DOM patch loops (load when patching)
- `skills/browser-bridge/references/interaction.md` - input, navigation, form controls (load when interacting)

## Working Rules

- Preserve the generic protocol shape. Do not add task-specific bridge commands for one-off actions when an existing RPC method can express the action.
- Prefer improving the shared protocol, client ergonomics, or skill/docs over introducing special-case commands.
- Keep the bridge token-efficient. Favor structured DOM/style data over screenshots or raw HTML dumps.
- Treat extension content scripts as classic scripts. Do not add ESM `import` statements to manifest-declared content scripts.
- Keep native-host startup robust for GUI launch contexts. Do not assume shell-specific `PATH` resolution.
- Treat the top-level `README.md` as npm-facing documentation. When adding or editing links or image references there, prefer absolute GitHub URLs instead of relative paths so the npm package page renders them correctly.

## JavaScript Typing

- Raw `.js` source files must always include JSDoc typings.
- Start raw JS modules with `// @ts-check`.
- Add JSDoc typedefs and annotations for exported functions, key internal helpers, parameters, return values, and non-obvious structured data.
- Do not leave newly added raw JS logic untyped.
- Run `npm run typecheck` after changing JS sources.

## Validation

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run lint` to check code style and formatting.
- **After any AI edits**: Always run `npm run lint`, `npm run typecheck`, and `npm test` to ensure changes don't break existing functionality.
- When touching the extension/browser protocol path, verify at least one live CLI flow against Chrome if possible.

## Agent Support Maintenance

When adding or modifying agent/editor support (e.g., adding a new IDE or agent client):

1. **Alignment requirement**: Agent support must be kept consistent across:
   - Code base: `packages/agent-client/src/install.js` (supportedTargets, skill paths)
   - Code base: `packages/agent-client/src/mcp-config.js` (MCP_CLIENT_NAMES, config shapes, paths)
   - Documentation: `README.md` (text descriptions, example commands)
   - Documentation: `docs/quickstart.md` (supported clients list, example commands)
   - Extension UI: Side panel settings and host setup UI

2. **Order preservation**: Maintain the same agent order across all locations. Current order:
   - codex, claude, cursor, copilot, opencode, antigravity, windsurf, agents

3. **README.md table restriction**: The "Supported Agents" table in `README.md` is **manually maintained** and should NOT be modified by AI agents. Only update text descriptions and example commands in README.md, not the visual table layout.

4. **When adding a new agent**:
   - Add to `supportedTargets` array in `install.js`
   - Add to `MCP_CLIENT_NAMES` in `mcp-config.js`
   - Add MCP config shape (key, includeType) to `MCP_CONFIG_SHAPES`
   - Add global and local config paths to `getMcpConfigPath`
   - Add global and local skill paths to `GLOBAL_SKILL_PATHS` and `LOCAL_SKILL_PATHS`
   - Update text descriptions in README.md and `docs/quickstart.md`
   - Update example commands in `docs/quickstart.md`
   - Do NOT modify the Supported Agents table in README.md

## CLI and Protocol Expectations

- `packages/agent-client/src/cli.js` is registered as `bbx` via the `bin` field in `package.json`.
- `package.json` uses the publish name `@browserbridge/bbx`.
- `npm link` from this repo exposes `bbx`, `bbx-mcp`, `bbx-daemon`, and `bbx-install` machine-wide for consumer repos.
- When working from this repository for debugging, treat `npx bbx` as the default agent invocation even if the user says `bbx` or asks to use the skill.
- Do not rewrite end-user docs or skill guidance to `npx`; published instructions should continue to assume the CLI is globally installed and invoked as `bbx`.
- Prefer the generic `call` path for arbitrary bridge methods.
- High-level helper commands are acceptable only when they map cleanly onto shared protocol methods and do not narrow the protocol surface.

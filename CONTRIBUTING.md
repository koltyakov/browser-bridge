# Contributing to Browser Bridge

## Dev setup

```bash
git clone <repo>
cd browser-bridge
npm install
```

No build step - the project runs directly from source (`type: "module"`).

## Running tests

```bash
npm test          # run all tests (with c8 coverage)
npm run lint      # ESLint
npm run typecheck # TypeScript type-check (JSDoc annotations)
```

All tests use Node's built-in test runner (`node --test`). No Jest or Mocha.

## Project structure

```
packages/
  protocol/      Shared request/response types, error codes, defaults, normalization
  native-host/   Unix socket daemon (bbx-daemon) + install scripts
  agent-client/  BridgeClient, CLI (bbx), setup helpers
  mcp-server/    MCP stdio server (bbx-mcp) + tool handlers
  extension/     Chrome extension (background, content scripts, UI)
scripts/         Build and packaging scripts
docs/            Internal planning and reference docs
```

## Making changes

- **Protocol changes** belong in `packages/protocol/src/` - shared by all packages.
- **Daemon changes** live in `packages/native-host/src/daemon.js`.
- **CLI commands** are registered in `packages/agent-client/src/command-registry.js`.
- **MCP tools** are defined in `packages/mcp-server/src/server.js` (schema) and `handlers.js` (logic).
- **Extension logic** lives in `packages/extension/src/background.js`.

Run `npm run lint && npm run typecheck && npm test` before opening a PR.

## Pull requests

- Keep PRs focused - one logical change per PR.
- Add or update tests for any new behaviour (test files live in `packages/*/test/`).
- Update `CHANGELOG.md` under `[Unreleased]`.
- The CI matrix tests Node 18, 20, and 22 - make sure nothing uses APIs newer than Node 18.

## Extension packaging

```bash
npm run package:extension   # produces dist/browser-bridge-extension-<version>.zip
```

The ZIP can be submitted to the Chrome Web Store. Do not commit `dist/`.

# Project Guide

## Overview

- `Browser Bridge` is a Chrome extension plus local Native Messaging bridge for token-efficient, scoped browser inspection and patching.
- Main areas:
- `packages/extension`: MV3 extension runtime, content script, popup, side panel, offscreen cropper
- `packages/native-host`: local daemon, native host bootstrap, manifest installer
- `packages/protocol`: shared protocol shapes, normalization, error codes, budgeting
- `packages/agent-client`: local CLI and subagent-facing bridge client
- `skills/browser-bridge`: skill instructions for using the bridge from Codex

## Working Rules

- Preserve the generic protocol shape. Do not add task-specific bridge commands for one-off actions when an existing RPC method can express the action.
- Prefer improving the shared protocol, client ergonomics, or skill/docs over introducing special-case commands.
- Keep the bridge token-efficient. Favor structured DOM/style data over screenshots or raw HTML dumps.
- Treat extension content scripts as classic scripts. Do not add ESM `import` statements to manifest-declared content scripts.
- Keep native-host startup robust for GUI launch contexts. Do not assume shell-specific `PATH` resolution.

## JavaScript Typing

- Raw `.js` source files must always include JSDoc typings.
- Start raw JS modules with `// @ts-check`.
- Add JSDoc typedefs and annotations for exported functions, key internal helpers, parameters, return values, and non-obvious structured data.
- Do not leave newly added raw JS logic untyped.
- Run `npm run typecheck` after changing JS sources.

## Validation

- Run `npm run typecheck`.
- Run `npm test`.
- When touching the extension/browser protocol path, verify at least one live CLI flow against Chrome if possible.

## CLI and Protocol Expectations

- `packages/agent-client/src/cli.js` should remain usable as a generic bridge tool.
- Prefer the generic `call` path for arbitrary bridge methods.
- High-level helper commands are acceptable only when they map cleanly onto shared protocol methods and do not narrow the protocol surface.

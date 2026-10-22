# Contributing to Browser Bridge (BBX)

## Dev setup

```bash
git clone <repo>
cd browser-bridge
make deps
```

Use the root Makefile for repository tasks. Development requires GNU Make, Node.js 20 or later, and the Go version in `go.mod`. Run `make build` to compile the TypeScript extension and Go executable. See [development](docs/development.md) for details.

## Running tests

```bash
make test         # Go race tests and Node tests with coverage
make format       # oxfmt and gofmt
make lint         # oxlint and oxfmt check
make typecheck    # TypeScript and typed JavaScript
```

TypeScript tests use Node's built-in test runner (`node --test`) for the extension, shared protocol, npm launcher, and real-process integration. Go tests beside the implementation own runtime behavior and use the standard testing package.

## Project structure

```
cmd/bbx/          Go executable entrypoint
internal/bridge/  Go CLI, daemon, native host, MCP server, installation and setup
internal/protocol/ Generated Go wire bindings
protocol/         Canonical wire types, metadata, browser/build helpers, fixtures
packages/
  extension/      TypeScript Chrome extension (background, content scripts, UI)
  npm/            Zero-runtime-dependency npm bootstrap and launcher
tests/
  integration/    Real-process integration tests against the Go runtime
  native/         Native installation, packaging, and wire-contract tests
scripts/          Build and packaging scripts
docs/             User and contributor reference docs
```

## Making changes

- **Protocol changes** belong in `protocol/`: wire types in `types.ts`, shared browser/build helpers and method metadata in `src/`. Run `make generate-protocol` after changing canonical definitions.
- **Daemon changes** live in `internal/bridge/daemon.go`.
- **CLI commands** are dispatched in `internal/bridge/main.go`, with shortcuts in `cli_shortcuts.go`. Exercise the checkout with `make run ARGS='call health.ping'`.
- **MCP tools** are defined in `protocol/mcp-tools.json` (metadata and schemas), with runtime handling in `internal/bridge/mcp*.go`.
- **Extension logic** lives in `packages/extension/src/background.ts` and the related TypeScript modules.
- **Agent setup** lives in `internal/bridge/agents_config.go` and `agents_skills.go`.

Run `make check` before opening a PR.

## Pull requests

- Keep PRs focused - one logical change per PR.
- Add or update tests for new behavior: Go runtime tests beside the source; TypeScript tests in `packages/extension/test/`, `packages/npm/test/`, `protocol/test/`, and `tests/`.
- Update `CHANGELOG.md` under `[Unreleased]`.
- The CI matrix tests Node 20, 22, and 24 on Linux (plus macOS and Windows legs) - make sure nothing uses APIs newer than Node 20.

## Extension packaging

```bash
make package-extension     # produces dist/browser-bridge-extension-v<manifest-version>.zip
make check-extension-zip   # validates ZIP contents before upload
```

The ZIP can be submitted to the Chrome Web Store. Do not commit `dist/`.

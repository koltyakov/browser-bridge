# Shared protocol

`types.ts` is the canonical definition of JSON wire types for the Go runtime, Chrome extension, and TypeScript tests. Browser-local interfaces that contain DOM objects or callbacks stay TypeScript-only; the generator excludes those interfaces and rejects unsupported syntax in wire types.

`src/` contains method metadata, error codes, defaults, and JavaScript helpers for browser and build use. `mcp-tools.json` is the canonical MCP tool metadata and schema source. The CLI, daemon, native host, and MCP server are implemented only in Go under `cmd/bbx` and `internal/bridge`.

```sh
make generate-protocol
make check-protocol
```

Generation produces:

- `internal/protocol/types.gen.go`: Go structs, enums, optional fields, and nullable values.
- `protocol/generated/bridge.schema.json`: JSON Schema for the same wire types.
- `internal/bridge/generated/catalog.json`: method metadata and budgets from the shared protocol sources, plus MCP tool schemas and instructions from `protocol/mcp-tools.json`.
- `internal/bridge/assets/skills.bundle`: deterministic embedded copy of the shared CLI skill files.

The method and error unions in `types.ts` must match the shared registries. Generation fails if they disagree. Browser/build imports use `protocol/src/`; wire types come from `protocol/types.ts`.

Generated files are checked in. `go build ./cmd/bbx` and `go test ./...` work without Node or npm. Node is needed only to regenerate shared definitions and assets. CI checks for stale output before testing.

`fixtures/wire.json` is read by both Go tests and TypeScript schema tests. It exercises required fields, discriminated responses, null versus omission, explicit zero values, unknown fields, and invalid method/error names. Go's `Optional[T]` preserves omission; `Nullable[T]` preserves explicit null. Arbitrary JSON payloads use `json.RawMessage`; they are not converted through floating-point maps.

Change the source definition and regenerate instead of editing generated Go or JSON files.

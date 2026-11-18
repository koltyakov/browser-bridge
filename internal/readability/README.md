# Document-only Readability

This is a reproducible subset of `codeberg.org/readeck/go-readability/v2`
v2.1.3 and `github.com/go-shiori/dom` at commit
`73569d674e1c`. Both MIT licenses are retained alongside their source.

Browser Bridge supplies a DOM parsed by `golang.org/x/net/html` from a browser's
Unicode HTML snapshot. It never needs charset sniffing, reader decoding, or
Readability's network fetching. Importing upstream's document API nevertheless
runs initialization from its reader dependencies, retaining charset tables in
the executable.

## Audit boundary

`scripts/readability-sources.json` pins the SHA-256 of every copied source file
and license. `scripts/vendor-readability.mjs` makes only these changes:

- Rewrites imports to the internal copies of DOM helpers, rendering, and re2go.
- Omits `Parser.Parse(io.Reader, ...)`, including its now-unused `io` import.
- Adds generated-file provenance headers.
- Runs `gofmt` to order the rewritten imports.

The document extraction algorithm, metadata, DOM helpers, and generated re2go
matchers are otherwise unchanged. Upstream's reader/network wrappers, encoding
parser, CLI, and readability preflight API are not copied. No stub replaces an
omitted API. The small handwritten `FromDocument` wrapper calls the original
`NewParser().ParseDocument` implementation.

The upstream module remains a **test-only reference**, not a runtime import.
Differential tests compare this subset against upstream's fixture corpus and
verify that parsing does not mutate its input. A dependency test rejects the
upstream DOM package, charset detector, and external encoding packages in the
Windows executable's dependency graph.

## Updating

1. Review upstream changes and licenses, especially document mutation, sanitizing,
   metadata, and any new I/O or decoding imports.
2. Update the module versions in `go.mod` and the source checksum manifest.
   Do not simply accept a changed checksum without reviewing its source diff.
3. Run `make generate-readability check-readability`.
4. Run `make lint typecheck test`, including the upstream differential tests,
   and rebuild all release targets to check the unchanged size limits.

Ordinary Go builds use the checked-in subset. They require no Node runtime,
source transformations, module replacements, or build overlays.

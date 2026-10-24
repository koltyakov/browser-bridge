# Legacy contract fixtures

These JSON expectations were captured on 2026-10-22 from the JavaScript runtime before its removal. Tests read them with Go's standard library. No JavaScript implementation or executable capture script is retained.

- `cli-formatters.json`: 141 wire responses with summaries, annotations, sanitized output, and batch results. Includes every recovery code, UTF-16 truncation boundaries, ANSI escapes, sensitive payloads, metadata, and output budgets. The clock was fixed at 1700000000000.
- `cli-batch-validation.json`: seven invalid batches, including mutations, malformed entries, unknown methods, and routing validation.
- `cli-batch-error.json`: a thrown transport error, including its summary and omission/null semantics.
- `cli-printer.json`: six stdout, stderr, and exit-status cases, including exact sensitive output and unsuccessful waits.
- `cli-argument-errors.json`: eleven invalid CLI argument combinations.
- `extraction.json`: seven Readability results for article selection, metadata, Unicode whitespace, sanitization, semantic/body fallbacks, and Markdown truncation.
- `mcp-doctor.json`: five diagnostic reports for readiness, untrusted fields, compatible minor versions, malformed health, and authentication failures.
- `mcp-results.json`: seven tool results covering evidence limits, typed errors, screenshots, and exact WebMCP schemas. Tests retain the previous exclusion of serialization-order-dependent cost fields.
- `mcp-subscriptions.json`: five SDK wire messages for acknowledgments, invalid filters, cancellation followed by ping, and graceful subscription completion.

`$PROTOCOL_VERSION`, `$COMPATIBLE_MINOR_VERSION`, and `$SERVER_VERSION` replace release-specific version strings. Doctor fixtures were captured with compatible health inputs matching the JavaScript runtime's protocol 2.0. These substitutions keep protocol compatibility cases valid across releases without deriving behavioral expectations from Go code.

On 2026-10-24 the batch expectations in `cli-formatters.json`, `cli-batch-validation.json`, and `cli-batch-error.json` were intentionally compacted: items omit size and cost triples, null errors, unscheduled timing, a `response` equal to `evidence`, and meta keys other than warnings, truncation, continuation hints, a non-current protocol version, and the routed tab of an untargeted call. All other captured fields are unchanged.

Change expectations only when intentionally changing the public contract. Preserve distinctions between omitted fields, `null`, empty arrays, and empty objects.

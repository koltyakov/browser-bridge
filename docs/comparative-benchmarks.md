# Comparative browser task benchmarks

`make bench-comparative` runs paired task contracts against independently reset
local fixtures. It launches disposable browsers, not a personal profile. It does
not install a global native host, enable an existing window, download a comparator,
or call a model provider.

The shipped driver exercises BBX through real MCP stdio, the Go runtime, native
messaging, and the installed unpacked extension. Additional trusted driver modules
can run other browser tools or actual agent episodes. A driver module is executable
local code; only pass modules you trust.

## Run

```sh
BBX_BENCH_CHROME="/absolute/path/to/Chrome for Testing" \
make bench-comparative ARGS='--runs=5 --seed=100 --tasks=save,spa,frame-cross,disconnect'
```

Omit `--tasks` for the complete catalog. The default is one pilot repetition.
`--runs` accepts 1..1000; seeds increase once per repetition. Every configuration
receives the same seed for each task. Task/configuration ordering is randomized
deterministically, while measured browser workloads run serially.

The default browser is headless. The background-focus task is **unsupported** in
that mode, not passed. For that task, use `--headed` on a disposable desktop, such
as a non-root Linux test machine with an isolated display:

```sh
BBX_BENCH_CHROME="/absolute/path/to/chrome" \
xvfb-run -a make bench-comparative ARGS='--headed --runs=30'
```

Native messaging must resolve entirely inside the disposable home. The existing
isolation harness supports macOS/Linux, not Windows. No sandbox or origin-security
bypass is added. Do not run a build that rewrites `dist/ext` concurrently.

Portable runs load the private extension with `Extensions.loadUnpacked` over the
owned debugging pipe. They opt into extension debugging without the legacy
`--load-extension` or `--disable-extensions-except` switches that current branded
Chrome rejects. The browser must support this CDP method. On Linux, a cached
testing browser may need `CHROME_DEVEL_SANDBOX` set to an existing, correctly
installed sandbox helper. Do not use `--no-sandbox`.

## Task contracts

| IDs | Required behavior |
| --- | --- |
| `save` | Fill Email and save the main profile once, with a hidden duplicate control present for some seeds. |
| `spa` | Follow Dashboard through `pushState`, observe its heading, then save. A document reload fails. |
| `background` | Save in the assigned background tab without activating it or writing to the synthetic user tab. |
| `dialog-accept`, `dialog-dismiss` | Inspect a real JavaScript confirmation, perform the specified decision once, and verify the effect. |
| `dialog-inspect` | Inspect an already-open confirmation without resolving it. |
| `disconnect` | Disconnect after First commits in an ordered First/Late flow. Late must not run. Reconnect, inspect state, then perform a separate Recovery probe. |
| `disconnect-before` | Lose the client connection before starting the flow. Neither step may dispatch; reconnect and perform a Recovery probe. |
| `disconnect-after-commit` | Commit a save but withhold the application's response so the outcome wait cannot finish. Disconnect MCP, release the response, inspect state without resubmitting, and perform a Recovery probe. |
| `worker-retained`, `worker-detached` | Replace a verified MV3 worker with the specified attachment lifecycle, recover, and perform one new probe. |
| `frame-same`, `frame-cross`, `frame-nested` | Save only the Payment profile, with similarly named parent controls left unchanged. Cross-origin means a second real loopback origin. |
| `stale-unique`, `stale-ambiguous` | Replace an inspected control before dispatch. Reinspect a unique replacement; stop without a save when replacements are ambiguous. |

Fault injection belongs to the trusted controller, never to agent tools. A
controller must call `markFault()` only after establishing the requested boundary.
A missing fault invalidates the episode. The BBX stale-target driver checks the
replacement count and strict stale-reference rejection; the disconnect driver
waits for a server-recorded commit rather than sleeping before disconnect.

The current matrix does not include daemon SIGKILL, beforeunload/prompt dialogs,
frame navigation during input, or different-record stale replacements. Existing
chaos tests remain the place for native-process leak and daemon-kill checks.

## Independent verification

The fixture server keeps an append-only ledger of mutation attempts and commits.
There is no HTTP oracle/reset endpoint and no application-side deduplication.
An operation expected once fails if a second attempt or commit appears, even if
the final value is correct. Unexpected operations and wrong-frame writes are
separate violations. Wrong values also fail.

The browser controller observes tab activation transitions and native dialog
opening/closing events. Checking only the final foreground tab would miss brief
focus theft. A headless run cannot certify foreground behavior.

The task deadline is 30 seconds. A one-second audit window follows the final result
or error, including failed runs, to catch the fixture's delayed continuation.
Setup, task, audit, and cleanup durations are separate. Cleanup must finish too.
The fixed window is finite evidence, not a promise that no effect could occur later.
The ledger's measured window closes before browser teardown, so closing an owned
document cannot turn an inspect-only dialog task into a spurious dismissal failure.
SIGINT/SIGTERM abort the active episode and attempt owned-resource cleanup; the
report records interrupted and not-run cells rather than treating them as passes.

Success requires the task's independent effects, correct reported status, observed
fault where required, and successful cleanup. Negative tasks explicitly require
stopping. A safe refusal on an ordinary save is not task completion.

## Measurements and reports

Evidence is saved under `dist/comparative-benchmark/run-*/`:

- `results.json`: all planned cells, including unsupported and invalid ones.
- `report.json`: overall/per-task summaries and same-track paired comparisons.
- Each measured episode has `result.json`, raw `measurements.jsonl`, and driver
  provenance. BBX additionally saves actual MCP responses in `tools.jsonl`.
- Agent drivers must preserve their actual final response in `final.txt`.

Metrics have these meanings:

- `modelRequests` counts actual inference requests. Provider input/output usage
  must include repeated history, discovery, errors, recovery, and the final answer.
- `hostToolCalls` counts calls from the driver to its host tool interface, including
  errors. One code execution can contain multiple browser requests.
- `browserRequests` is independently instrumented transport traffic, or `null`
  when opaque. The shipped BBX driver deliberately reports `null`: host calls do
  not expose every internal retry, CDP command, or sequence step.
- `responseBytes` is serialized tool-response bytes. It is not a token estimate.
- `tokens` is provider-reported usage, or `null`. If any model request lacks usage,
  totals stay unknown. Cached/image input counts are input subsets, not additions.
  Scripted runs have no model and report no provider token cost.
- `latencyMs` includes task discovery, tool calls, retries, and recovery inside
  `run()`. Infrastructure-only `open()` is timed separately. This release measures
  warm task execution, not model-inclusive cold startup.
- `goalAtMs` is when the required ledger commits first existed. It does not replace
  the agent's own verification or establish correctness if extra effects follow.
- `recoveryMs` measures from the controller's fault marker to its verified recovery
  marker. It is `null` when recovery was not independently established.

The summaries include planned completion denominators, per-task Wilson 95%
intervals, unsuccessful-run latency, duplicate counts, missing measurements, and
timeouts. Failures retain resource costs. Pairwise latency differences use only
matched task/seed cells where both configurations succeeded. Unsupported and invalid
pairs are explicit. Different tracks are never compared as equivalent observations.

Use at least 30 agent repetitions per task for an initial comparison and preferably
200 scripted repetitions for latency distributions. Small-sample p95 is exploratory.
Use per-task paired results as the primary comparison; pooled intervals across
different task families do not establish statistical superiority. The runner does
not compute a blended winner score or claim significance from a pilot.

Exit status is nonzero if a supported episode fails or is invalid. Unsupported
cells stay visible in the planned denominator but do not fail the smoke command.
Zero observed duplicates is not an exactly-once guarantee.

## Add a real comparator or agent

An optional second BBX configuration uses `input.perform` for fill/save/outcome
composition. It exercises the real multi-driver path without pretending to be
another product. Its supported families are baseline, SPA, background, and frames.

```sh
BBX_BENCH_CHROME="/absolute/path/to/chrome" \
make bench-comparative ARGS="--runs=5 --tasks=save,spa,frame-cross --driver=$PWD/tests/fixtures/comparative-benchmark/bbx-sequence-driver.ts"
```

Pass an absolute module path, once for each extra configuration:

```sh
BBX_BENCH_CHROME="/absolute/path/to/chrome" \
make bench-comparative ARGS='--runs=30 --driver=/absolute/path/to/adapter.ts'
```

The module exports `createDriver(options)` returning the
[`Driver`](../tests/fixtures/comparative-benchmark/types.ts) contract. Use a unique,
lowercase configuration name and exact version. Agent configurations additionally
declare model revision and an instruction hash. The runner saves the entry-module
hash, fixture hash, and browser/native/extension provenance supplied by the driver.
Pin and archive the adapter's transitive dependencies too; an entry-module hash
alone does not freeze them.

External values are runtime-validated, not trusted because a module claims the
TypeScript interface. Configuration names are 1..64 lowercase letters, digits,
or hyphens; versions and model IDs must be nonblank trimmed strings. Agent
instruction hashes must be 64-character SHA-256 hex digests. Supported task IDs
must exist in this catalog and cannot be duplicated. These are format checks,
not proof that a binary/model revision or instruction hash matches reality.

Measurement events, usage, observations, and run results use closed data shapes:
unknown fields/kinds, inherited fields, getters, missing required fields, and
coerced numeric strings are rejected. `model` requires `usage: null` or an object
with both `input` and `output` as nonnegative safe integers. Optional cached/image
counts must be omitted when unknown and cannot exceed input. Explicit zero is
valid; missing counts are never silently changed to zero. Rejected measurements
do not change counters or traces, and invalidate the episode even if adapter code
catches the validation exception. Accumulated counts must also remain safe integers.

Session lifecycle methods must be functions, provenance must be JSON-compatible
object data with finite numbers, no cycles, and bounded nesting, and `close()`
must resolve to `undefined`. Malformed sessions still
get a cleanup attempt when a callable `close` exists. Available independent
effects survive validation failures. A malformed adapter never earns task success.

Driver responsibilities:

1. Declare supported task IDs before running. Do not remove failures afterward.
2. `open(context)` prepares a fresh isolated browser/session with the assigned URL.
   It must not run model inference or solve the task. Do not share learned task
   state across episodes.
3. `run()` uses the tool's supported interface. UI-action tasks prohibit direct
   HTTP writes or page-script state mutation. Controller hooks only inject declared
   faults. Agent prompts get the user instruction and target, not the `Task.expected`
   oracle, ledger hooks, fixture source, or control channel.
4. Call `context.measure()` for every model request and host invocation. Use exact
   provider usage when available, otherwise `usage: null`. Never report
   `deliveredTokens`, string length, or image dimensions as billing.
5. Return `reported` from the actual final response, not from hidden oracle state.
   Agent drivers also return `finalText`. Archive raw model/tool traces and document
   the pinned rule that maps final responses to this status.
6. `observe()` uses an independent controller channel. Return `null` for unavailable
   focus/dialog evidence, not zero. It must not use the agent's success flag.
7. `close()` stops owned work and releases owned processes even after timeout.
   Honor the abort signal. A setup timeout whose resources cannot be joined is a
   cleanup failure, not a valid measurement.

For comparisons, keep model/settings, task text, browser build, viewport, locale,
hardware, deadlines, and UI-action restrictions identical. Each tool may use its
documented semantic locators, batching, screenshots, or code orchestration. Include
its instructions in agent input usage. Architecture-specific worker restart tasks
should be reported separately from cross-product client-disconnect tasks.

Only actual BBX scripted configurations are shipped here. There are no fabricated
Browse, Code Mode, or agent results, and no automatic provider charges.

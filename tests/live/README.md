# Live browser verification

For independent mutation-ledger scoring, paired task seeds, external comparator
drivers, and agent usage accounting, see
[comparative benchmarks](../../docs/comparative-benchmarks.md). Run
`make bench-comparative` with `BBX_BENCH_CHROME` set to a disposable Chrome executable.
The existing interaction microbenchmark remains available as `make bench-interaction`.

## Isolated native-input and observer regressions

```sh
BBX_INPUT_CHROME="/absolute/path/to/Chrome for Testing" make test-input-live
```

This opt-in target launches its own headless Chrome for Testing or Chromium,
with a fresh profile and home directory, extensions disabled, and a private
debugging pipe. It does not attach to a running browser, expose a debugging
port, install a native host, change an access grant, or activate a personal tab.
No browser executable is guessed. Missing prerequisites fail rather than skip.

The suite loads unchanged emitted content modules into real isolated worlds.
It forces `MutationObserver` constructor/`observe()` exceptions and a finish-time
read exception, checks cleanup and same-world recovery, and verifies actual
DOM and trusted CDP clicks without replay or false application verification.
It also checks prevented deletion cannot append replacement text, successful
native clearing is read back before insertion, and inactive key-dependent
flows stop before dispatch while plain text insertion remains available.

Legacy tests compile the actual pre-aftermath `content-input.ts` from commit
`45f35307a1b46daa36de196df405dbe7ed39e11a`, without rewriting its responses.
They exercise real positive effects, the old beforeunload navigation overclaim,
and an observation evicted by the legacy receiver. The current background
controller must preserve supported evidence but discard unsupported navigation
and changed claims. This requires that commit in the local Git history; fetch
it before running from a shallow checkout, or explicitly set
`BBX_INPUT_LEGACY_REF` to another available full pre-aftermath commit SHA.
The suite never fetches history automatically.

Results, browser identity, module/source hashes, and synthetic evidence remain
under `dist/input-live/run-*/`. Owned targets, the browser process, profile,
and home are cleaned up. The controller uses direct CDP/content-module
adapters; this is not a test of installed extension grants, native messaging,
the Go daemon, or OpenCode MCP integration. Do not run builds that rewrite
`dist/ext` concurrently. The target is excluded from `make test`.

## Full MCP/native/extension chain

```sh
BBX_CHAIN_CHROME="/absolute/path/to/Chrome for Testing" \
BBX_CHAIN_LEGACY_EXTENSION="/absolute/path/to/older-built-extension" \
make test-full-chain-live
```

This opt-in macOS/Linux suite installs a private-ID copy of the actual built
extension in a disposable headless Chrome profile. It redirects HOME, macOS
`CFFIXED_USER_HOME`, XDG directories, native-host manifests and the bridge home.
No personal profile or system native registration is changed. Chrome must
support unpacked extensions and native messaging; sandboxed packages and Windows
are unsupported. Native-host lookup must succeed inside the isolated home.
There is no fallback to the user's normal registration.
The private browser bypasses inherited proxies for its loopback fixture and uses
Chrome's mock-keychain/basic password-store test options on macOS. It never
opens the user's keychain or disables browser origin/TLS checks.

Each request under test travels through real MCP stdio, the current Go
server/client/daemon, Chrome Native Messaging and the installed extension.
Page-state reads and verified clicks also use the exported generated Code Mode
bindings, backed by that same MCP connection.
The private debugging pipe is only for fixture observation, initial private
access setup and worker termination, not an adapter for requests under test.

Coverage includes both MCP protocol eras, an actual MV3 worker replacement
and native-host reconnection, MCP cancellation between native input steps,
disconnecting/reconnecting MCP during a sequence, independent exact-once page
verification, and settled request/scheduler/connection counts.
Worker recovery covers both a debugger session retained across termination and
a session normally detached by the burst-idle timer before termination.
The new worker resets a retained session only after a non-mutating
`Page.getFrameTree` through Chrome's extension-owned `sendCommand` boundary
proves ownership. It does not use trusted-client-only V8 commands, activate the
tab, or retry input. Each post-restart click must take effect exactly once.
If interrupted input returns an MCP error before the transport closes, its
recovery must also forbid replay and omit retry backoff. A local MCP error
without a confirmed bridge result cannot establish how many steps executed.

Mixed-version coverage runs the current Go/MCP build with a genuinely older,
protocol-compatible extension as well as the current extension. Supply an
already built older directory containing `manifest.json`, `src/background.js`
and `src/content-input.js`. Its manifest version must differ from the current
build. Do not relabel the current build or fabricate legacy responses.
The suite does not fetch, build or install an old release automatically.
The old extension must predate `protocol.capabilities`; that RPC must fail
explicitly, while Go-local signature search and existing browser actions work.
The suite tests each version in its own isolated browser/daemon, not simultaneous
mixed-version peers.

Missing prerequisites fail rather than skip. Evidence includes original
extension versions and file hashes, actual responses and cleanup status under
`dist/full-chain-live/`. Only owned process groups are stopped. No mutation is
automatically retried after interruption. This target is excluded from
`make test`; do not run builds that rewrite `dist/ext` concurrently.

## Isolated macOS Arc verification

The original browser-matrix runner was a disposable diagnostic. Its maintained
Arc replacement is `tests/live/arc-runner`, invoked explicitly with:

```sh
BBX_ARC_BROWSER="/Applications/Arc.app/Contents/MacOS/Arc" make test-arc-live
```

The runner refuses to reuse an already-running Arc instance. It creates a fresh
run directory under `dist/arc-live`, redirects both `HOME` and
`CFFIXED_USER_HOME`, and sanitizes inherited BBX destinations and credentials.
It starts Arc with Chromium's mock-keychain and basic password-store test flags.
It does not install into the user's browser directories, use the real keychain
as a fallback, disable security checks, or enable a browsing access grant.

Endpoint discovery reads only newly appended, complete startup-log lines and
port files that did not exist before launch. Before any HTTP or WebSocket
connection, the endpoint must match a fresh `DevToolsActivePort` inside the
disposable run. This permits Arc's isolated-home `Arc/User Data` root when it
ignores the requested Chromium profile, but never scans or attaches to the real
default profile. Symlink escapes, endpoint mismatches, non-loopback endpoints,
HTTP redirects, and ambiguous startup endpoints fail closed.

`result.json` reports `endpointDiscovery`, `profileIsolation`,
`endpointConnection`, `manifestCreation`, `nativeHostLookup`, and
`bridgeConnection` separately. Each stage is `passed`, `failed`, or `not_run`.
A log announcement cannot establish a connection. Manifest creation cannot
establish lookup: a private diagnostic extension must receive a matching nonce
and directory from an executed native host. Each candidate directory has its
own nonce, including the disposable home's Chrome and Chromium directories,
because Arc's profile and native-host lookup roots can differ. Only then does
the runner place the BBX manifest in the proven directory, copy the shipped
extension with a private ID, start an isolated BBX daemon, and check its
observed extension connection. This is not a full
page-read, input, or reinstall-recovery pass.

The owned process groups and temporary manifests are cleaned up; the disposable
home and logs remain as evidence. A startup stall is a discovery failure with
later stages `not_run`, not proof of a native-host failure. Optional deadlines can be passed
with `ARGS='--startup-timeout=30s --stage-timeout=20s'`. Missing prerequisites or
failed stages return a nonzero exit status. Focused Go tests run in `make test`
without launching a browser.

## Disposable headed-Chrome fault tests

`make test-chaos-live` is a separate, opt-in Linux suite. Use Chrome for Testing or non-sandboxed-package Chromium that supports `--load-extension`, as a non-root user, on a disposable machine or display. It never attaches to a running browser. Snap/Flatpak builds are unsuitable for the native host. macOS and Windows are deliberately unsupported here because native-host registration cannot yet be isolated by this harness on those platforms.

```sh
BBX_CHAOS_CHROME=/absolute/path/to/chrome xvfb-run -a make test-chaos-live
```

The suite copies the built extension into a new temporary directory with a private extension ID. It redirects HOME, XDG directories, Chrome's native-host registry, the browser profile, and the bridge home into that directory. It starts real headed Chrome and uses the real native messaging host and Go daemon. Chrome's private debugging pipe is used only by the test controller for fault injection and independent fixture observations. No public sites, existing access grants, real profiles, or installed native registrations are used. Do not run it concurrently with builds that rewrite `dist/ext`.

Each of two rounds kills the isolated daemon with SIGKILL, stops and verifies replacement of the MV3 worker, disconnects a caller between two native input steps, and disconnects a caller while an activity/network recording has a pending long-poll read. Recovery must include a page read and a verified click within 20 seconds. The suite never restarts the daemon itself after killing it, so the native-host reconnect must recover it. Interrupted input must not execute its delayed second step. A disconnected recording must release its page recorder, network capture, and registry slot without navigating the fixture. Only the disposable fixture is activated for native pointer input.

After every scenario, a separate 10-second cleanup deadline checks pending requests, mutation queues, agent/extension connections, debugger attachments and holds, capture ownership, page recorders, artifact files, native processes, browser tabs, and daemon file descriptors. Descriptor counts allow three transient descriptors above the initial baseline for the same daemon PID. This is a focused leak regression check, not a memory soak or proof of constant memory. Teardown closes clients and the owned browser process group, kills only native executables whose `/proc` environment matches the private bridge home, checks process exit, and removes the temporary directory. Logs and success/failure measurements remain in `dist/chaos-live/<run>/`.

Optional settings: `BBX_CHAOS_ROUNDS=1..5` and `BBX_CHAOS_RECOVERY_MS=5000..60000`. Missing prerequisites fail rather than silently skipping. These destructive tests are excluded from `make test`; Chrome-pipe framing and deadline helper tests run in the ordinary native test suite.

## Existing-browser visual tests

Run `make test-visual-live` with Browser Bridge's current development native runtime installed and access already enabled in Chrome. This target does not install/restart the running runtime, request access, activate a tab, or change unrelated tabs. If multiple profiles are enabled, set `BBX_LIVE_EXTENSION_ID` to the intended connection ID from `bbx status`.

The test opens a private local fixture in one background tab, simulates text, CSS, canvas, removal, subtle-pixel, distant and outside-scope changes, then checks the actual MCP tool output. An independent PNG decoder compares every returned crop pixel with separately captured full originals, verifies changed-pixel counts and checks coverage and complete chart/removal component boxes. It also exercises fixed/advancing references, after-only delivery, scrolling/layout invalidation, DPR 2, quota recovery, navigation cleanup and ordinary input/DOM/style/screenshot workflows.

Only the task-owned tab receives a temporary viewport override. The test resets that override, releases its handles, closes the tab and local server, and saves synthetic fixture evidence and timings under `dist/visual-live/<timestamp>/`. No user page pixels are captured. The test is separate from `make test` because it requires a real browser and an enabled access grant.

Background tabs can suspend animation-frame callbacks. The fixture waits for font readiness and forces layout rather than waiting on `requestAnimationFrame`. After changing DPR, three independently captured identical images establish a stable reference before the pixel-verification step. This preparation is outside measured comparison timings; the production tool still reports real rendering/animation differences rather than suppressing them.

Timing blocks compare ordinary operations before retaining a baseline, while retaining one, and after releasing it. Two warmups precede ten recorded samples per block, with repeated retained/released blocks to expose drift. Concurrent comparison/daemon-metrics calls check responsiveness. These are measurements on the same implementation, not an old/new binary comparison or proof of statistical equivalence. Avoid running other benchmarks or builds concurrently when collecting final latency numbers.

Image-token figures are explicitly dimension-based GPT-4o high-detail estimates using the documented 85 base plus 170 per 512-pixel tile rules. They compare delivered images with **one** new full scoped screenshot, exclude text metadata/history and do not measure API billing. Broad or unhelpful diffs are image-free by default. Explicit `fallback: "current"` returns at most one current full scoped image, never a full before/after pair. PNG bytes and image tokens are reported separately.

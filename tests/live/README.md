# Live browser verification

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

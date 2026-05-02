# Test Helper Guidance

This directory is for shared test-only harnesses used across packages.

## Chrome Mocking Rules

- Prefer dependency injection over global mutation. Production helpers should accept `chrome` or narrower callbacks in their options when practical.
- Do not read `globalThis.chrome` directly from newly added production helpers. Keep the Chrome dependency at the module boundary so tests can pass a fake explicitly.
- Reuse helper seams such as `createRuntimeMessageListener({ openSidePanelForTab })` instead of importing large entrypoints just to reach one behavior.
- When a top-level entry module must register Chrome listeners at import time, isolate the `globalThis.chrome` setup inside a test harness so the rest of the code can stay injection-friendly.
- Treat `packages/extension/src/background.js` as a temporary exception until the Phase 2 background loading seam lands. New background logic should prefer extracted helpers in `packages/extension/src/background-*.js` when possible.

## Helper Scope

- Keep helpers minimal and generic enough to share across packages.
- Prefer small fakes with explicit behavior over broad mock objects that silently accept anything.
- Add helpers here only when at least two tests or packages can reasonably reuse them, or when they define the standard harness pattern for a new area.
- Use `tests/_helpers/dom.js` for shared linkedom-backed `window` / `document` setup instead of open-coding DOM global mutation in each suite.
- Use `tests/_helpers/messagePort.js` for inspectable `chrome.runtime.connect()` port pairs instead of hand-rolled `postMessage` / `onMessage` stubs in UI tests.
- Use `tests/_helpers/chromeFake.js` for the standard minimal `chrome.*` surface and event emitters instead of rebuilding partial runtime/tabs/storage mocks in each extension suite.
- Use `tests/_helpers/loadBackground.js` when a test must import `packages/extension/src/background.js`; it owns the temporary `globalThis.chrome` injection and fresh dynamic import cache busting.
- Use `tests/_helpers/socketHarness.js` for temporary bridge-home socket paths and JSON-line test servers instead of re-implementing temp-dir and `net.createServer()` setup in each integration suite.

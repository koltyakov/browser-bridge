# Publishing

This is a maintainer document, not an end-user setup guide. End users should
start with [quickstart](./quickstart.md).

This repo publishes three kinds of release artifacts:

1. The Chrome extension ZIP for the Chrome Web Store
2. Five Go executables on the public GitHub `v<version>` release
3. The npm bootstrap/launcher package with the executables' pinned hashes

The extension depends on the local native host installed by `bbx install`. npm is the bootstrap and launcher, with zero runtime npm dependencies; the Go executable provides the CLI, native host, daemon, and MCP server. Global npm installation downloads the matching binary and initializes browser registration. Local dependency installation does not register browsers. If scripts were skipped, the first command downloads the binary and the user runs `bbx install` explicitly.
The native runtime embeds the Browser Bridge store extension ID, so end-user docs should default to plain `bbx install`. Only unpacked or non-store builds should require `bbx install <extension-id>` or `BROWSER_BRIDGE_EXTENSION_ID=<extension-id>`.

## Version source

For local work, edit only `manifest.json.version`. `make sync-version` mirrors it into `package.json` and both root version entries in `package-lock.json`. Build and packaging targets synchronize these files automatically. `make generate-protocol` also refreshes the embedded Go catalog.

In release pipelines, the Git tag is authoritative even when the checkout contains an older version. The workflow resolves `refs/tags/vX.Y.Z`, synchronizes the extension/npm metadata, and regenerates the catalog before checking or building artifacts. Other pipeline systems can supply the same tag through `RELEASE_TAG`. Branch and pull-request refs do not override the manifest.

All artifacts use that resolved version. Tags must use stable `vX.Y.Z` versions compatible with Chrome's numeric manifest version; prerelease suffixes are rejected.

## Release checklist

1. Set the local version in [manifest.json](../manifest.json) and run `make generate-protocol`. Do not edit npm version mirrors independently.
2. Run `npm install` if dependencies changed.
3. Run `make release-check`.
4. In npm package settings, add a GitHub Actions trusted publisher for this repository and workflow file `release.yml`.
5. Push the release tag `v<version>`. GitHub Actions takes the release version from this tag, runs checks, builds all native targets after tests, publishes and verifies their GitHub release assets, then publishes npm and uploads the extension ZIP artifact.
6. After the first successful trusted publish, set npm package publishing access to require 2FA and disallow tokens, then revoke any old automation token.
7. Upload the extension ZIP from `dist/browser-bridge-extension-v<version>.zip`.
8. Complete the Chrome Web Store listing, privacy fields, and reviewer instructions.
9. Smoke-test the published extension against the published CLI using `bbx install`.

## Build The Extension ZIP

The repo now includes a reproducible packaging step:

```bash
make package-extension
make check-extension-zip
```

That compiles the extension's TypeScript sources, stages browser JavaScript and assets in `dist/ext/`, and writes the upload artifact below. The ZIP excludes TypeScript sources, declarations, and development source maps.

```bash
dist/browser-bridge-extension-v<version>.zip
```

## Publish native assets and npm

The npm manifest contract is:

```ts
{
  version: string;
  artifacts: Record<string, { asset: string; sha256: string; bytes: number }>;
}
```

It contains exactly these platform keys and GitHub asset names:

| Platform key | Asset |
| --- | --- |
| `darwin-arm64` | `bbx-darwin-arm64` |
| `darwin-x64` | `bbx-darwin-x64` |
| `linux-arm64` | `bbx-linux-arm64` |
| `linux-x64` | `bbx-linux-x64` |
| `win32-x64` | `bbx-windows-x64.exe` |

The wrapper downloads `https://github.com/koltyakov/browser-bridge/releases/download/v<packageVersion>/<asset>`. It never selects a newer release. Size and SHA-256 verification use the values shipped in npm.

Always run `make package-native-all` after tests to rebuild all five platforms for the resolved version. `scripts/prepare-npm.mjs` runs during prepack. It requires synchronized npm metadata and all five expected binary files in `dist/cli`, rejects empty files and files at or above 10,000,000 bytes, then hashes the files and atomically writes `packages/npm/native-manifest.json`. It reads sizes directly from the binaries; there is no separate build report or per-binary version check. Do not commit this generated manifest.

The tarball contains only `packages/npm/bin`, `packages/npm/src`, the generated manifest, and package metadata/license/docs. Go binaries live on GitHub Releases. Shared TypeScript helpers in `protocol/` support browser builds and generation; they are not a published runtime or client library. `npm ci` in a source checkout skips the wrapper bootstrap, so CI does not download a published release during dependency installation.

The release workflow uses Node builtins and `gh` to publish native assets. It creates a public release if needed, requires the tag to exist, and downloads existing binary assets to compare their size and digest before uploading missing assets. Uploads never use `--clobber`. A mismatched existing asset fails the release; publish a new version rather than replacing bytes already pinned by npm. A pre-existing draft release must be made public before this step.

For a manual fallback, run checks and build the extension first, then:

```bash
make package-native-all
make publish-native
make pack-dry-run
make pack
make publish-npm ARGS=--provenance
```

Authenticate `gh` with permission to create releases in `koltyakov/browser-bridge`. The release tag must already exist remotely. Keep the native build unchanged between asset upload and npm packing. `make package-npm` is a local build-and-pack shortcut; it does not publish native assets. `make publish-npm` selects the resolved version's tarball; override it with `TARBALL=path` if needed.

The tag workflow publishes npm through trusted publishing with OIDC. Its token needs `contents: write` for GitHub releases and `id-token: write` for npm. It retains the npm tarball and extension ZIP as workflow artifacts.

Trusted publishing requires npm CLI `11.5.1+`. The release workflow upgrades npm explicitly before running `npm publish`; if publish fails with `E404` or authentication issues, verify the workflow still prints an npm version at or above that threshold.

Native signed updates use a separate feed and embedded trust keys. Publishing GitHub assets and npm hashes does not configure or sign that feed. See [native updates](../internal/bridge/README.md#native-updates).

## Chrome Web Store Submission

### Store assets you still need to prepare manually

- At least one real product screenshot
- One 440x280 promotional image
- A privacy policy URL
- Support/contact URL or support email in the developer dashboard

The manifest now includes packaged extension icons, but the promo image and screenshots are store-listing assets, not files inside the extension ZIP.

### Single purpose statement

Use one narrow sentence. Suggested draft:

`Browser Bridge lets a connected developer agent inspect and patch web pages in an explicitly enabled Chrome window through a native messaging bridge on the browser machine.`

The text in this document is guidance only; it is not uploaded automatically. Before every submission, manually compare the Chrome Web Store dashboard listing, privacy answers, and reviewer instructions with this document and the current source behavior, then update both sides together.

### Permission justifications

Use reviewer-facing explanations tied to the product purpose:

- `debugger`: used on demand for Chrome DevTools Protocol reads and page-context evaluation, screenshots, depth-limited accessibility data, native pointer/text dispatch, explicit JavaScript dialog inspection/accept/dismiss, optional bounded all-resource network metadata, and related debugger-backed inspection helpers; Browser Bridge coordinates short operations or explicit capture/interception ownership rather than attaching permanently
- `alarms`: periodically wakes the Manifest V3 service worker while a browser window is explicitly enabled so native messaging and bridge routing remain responsive; the alarm is cleared when access is disabled
- `nativeMessaging`: required to communicate with the local Browser Bridge daemon
- `scripting`: used to inject and coordinate the scoped page instrumentation flow
- `sidePanel`: provides the side panel control surface
- `storage`: persists enabled-window approval, bounded recent action summaries, and setup/UI state for the current browser session
- `tabs`: enumerates tabs and validates that a request stays inside the enabled window
- `host_permissions` on `<all_urls>`: needed because the tool is designed to inspect whichever site the user explicitly approves, not a fixed site list

Reviewers will likely scrutinize `debugger`, `nativeMessaging`, and `<all_urls>`. Keep the listing language narrow and explicit about user approval, the local extension/native-host path, and the separately configured authenticated remote option. Do not describe raw remote TCP as encrypted.

### Privacy fields

Current expected answers with the code as it exists today:

- Remote code: do not default this to `No`. Browser Bridge can execute user-requested expressions in page context through the Chrome Debugger API. Answer this honestly in the dashboard and explain that the extension does not load remote-hosted extension scripts.
- Data collection: disclose the page data the product can access for the enabled window, including browsing/page content, DOM/style/layout and semantic accessibility data, console output, fetch/XHR and optional all-resource network metadata, dialog messages/default prompt text, storage key metadata and deliberate exact sensitive values when requested, screenshots when requested, and native pointer/text actions
- Sensitive reads: verify ordinary storage is metadata-only; exact values use a distinct sequential, non-retryable, atomic method with visible warning activity and no value retention in logs/diagnostics
- Network exclusions: explain that CDP URLs redact credentials, fragments, and query values, and that Browser Bridge does not return request/response bodies, cookies, authorization values, or complete headers from all-resource capture
- Diagnostics and stale recovery: explain that persisted diagnostic summaries exclude dialog text and sensitive payload values, while optional same-document stale recovery keeps bounded in-memory hashed semantic descriptors rather than writing ref attributes into the page
- Data sale: `No`
- Data handling: the extension and native host communicate on the browser machine, and local clients are the default; an explicitly configured authenticated remote destination can receive results over the user's own SSH tunnel or network route, and a connected agent or IDE may still forward data onward under its own policy
- Privacy policy: must clearly state what data the extension can access, that approval is window-scoped, and that Browser Bridge itself does not operate a Browser Bridge cloud service

If product behavior changes, update the privacy answers before submission.

### Reviewer test instructions

Google marks the Test Instructions tab as optional, but Browser Bridge should still provide it because the product depends on local CLI/native-host setup. Suggested draft:

1. Install the published extension from the Chrome Web Store listing.
2. Install Node.js 20+ on the same machine.
3. Run `npm install -g @browserbridge/bbx`.
4. Run `bbx install`.
5. Run `bbx doctor`, then `bbx status`. If the daemon is still unavailable, run `bbx-daemon` and repeat those checks.
6. Open any normal web page in Chrome.
7. Open the Browser Bridge popup or side panel and enable Browser Bridge for the current browser window.
8. Run `bbx tabs`, `bbx page-text`, `bbx call dom.query '{"selector":"body","maxNodes":5}'`, `bbx call styles.get_computed '{"selector":"body"}'`, and `bbx call dom.get_accessibility_tree '{"maxNodes":20,"maxDepth":3,"interactiveOnly":true}'`. Confirm each returns bounded structured data from the enabled window.
9. On a test page with a button and text field, query each element to obtain its ref. Run DOM click/type calls and verify the page state with DOM reads. Repeat with raw `input.click` or `input.type` using `executionMode: "cdp"`, and verify again. Confirm targeted calls include resolution/execution metadata; `cdp_press_key` and `scroll_into_view` use separate contracts. This demonstrates native input without claiming dispatch guarantees application state.
10. Apply a temporary style or text patch, list it, and explicitly roll it back. Apply another temporary patch, disable or switch the enabled window, and confirm Browser Bridge attempts best-effort cleanup while the original document remains available. Do not treat automatic cleanup as guaranteed after navigation or document replacement.
11. On a test page that opens an alert/confirm/prompt, run `bbx call page.handle_dialog '{"action":"inspect"}'`, copy the returned `dialogId` (`<uuid>:<generation>`), then pass that exact value as `expectedDialogId` to an explicit accept or dismiss call. Confirm no dialog is changed by inspection alone and do not automatically repeat a conflict.
12. Run `bbx call page.wait_for_load_state` with a URL condition on a normal or SPA route and confirm `finalUrl` and `observedNavigationKind` are returned.
13. Trigger one fetch/XHR and confirm `bbx network` returns bounded metadata. Then run the CDP network lifecycle in order: `start`, reproduce one page/resource load, `read`, then `stop`. Confirm lifecycle/drop metadata is present and URL query values are redacted. Do not expect events from before `start` or any bodies/cookies/authorization values.
14. Request a tight element or region screenshot and confirm image data is returned only for the enabled window. Check `bbx console` after generating a test console message and confirm bounded console output is returned.
15. Disable access in the popup or side panel and confirm a subsequent tab-bound request returns `ACCESS_DENIED` until access is enabled again.
16. Confirm the packaged `manifest.json` permissions are exactly `alarms`, `debugger`, `downloads`, `nativeMessaging`, `scripting`, `sidePanel`, `storage`, `tabGroups`, and `tabs`, with `<all_urls>` host access. `downloads` enables browser-managed large downloads and progress/control; BBX exposes only downloads it starts.

## Post-Publish Follow-Up

- Update [README.md](../README.md) and [quickstart.md](./quickstart.md) if the Chrome Web Store URL changes.
- Re-run a live flow with `bbx install` after the first published build is available.

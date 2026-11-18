# Publishing

This is a maintainer document, not an end-user setup guide. End users should
start with [quickstart](./quickstart.md).

This repo publishes three kinds of release artifacts:

1. The Chrome extension ZIP on GitHub Releases and for manual Chrome Web Store submission
2. Five Go executables on the public GitHub `v<version>` release
3. The npm bootstrap/launcher package, which selects native releases at installation

The extension depends on the local native host installed by `bbx install`. npm is the bootstrap and launcher, with zero runtime npm dependencies; the Go executable provides the CLI, native host, daemon, and MCP server. Global npm installation downloads the latest stable binary, or a native version selected with `BBX_VERSION`, and initializes browser registration. Local dependency installation does not register browsers. If scripts were skipped, the first command downloads the binary and the user runs `bbx install` explicitly.
The native runtime embeds the Browser Bridge store extension ID, so end-user docs should default to plain `bbx install`. Only unpacked or non-store builds should require `bbx install <extension-id>` or `BROWSER_BRIDGE_EXTENSION_ID=<extension-id>`.

## Version source

For local work, edit only `manifest.json.version`. `make sync-version` mirrors it into `package.json` and both root version entries in `package-lock.json`. Extension/native build targets synchronize these files automatically. Packing the npm launcher does not synchronize versions or require native binaries. `make generate-protocol` also refreshes the embedded Go catalog.

In release pipelines, the Git tag is authoritative even when the checkout contains an older version. The workflow resolves `refs/tags/vX.Y.Z`, synchronizes the extension/npm metadata, and regenerates the catalog before checking or building artifacts. Other pipeline systems can supply the same tag through `RELEASE_TAG`. Branch and pull-request refs do not override the manifest.

The combined release workflow labels all artifacts with that resolved version. This naming convention does not bind npm installations to that native version. Tags must use stable `vX.Y.Z` versions compatible with Chrome's numeric manifest version; prerelease suffixes are rejected.

## Release checklist

1. Set the local version in [manifest.json](../manifest.json) and run `make generate-protocol`. Do not edit npm version mirrors independently.
2. Run `npm install` if dependencies changed.
3. Run `make release-check`.
4. In npm package settings, add a GitHub Actions trusted publisher for this repository and workflow file `release.yml`.
5. Push the release tag `v<version>`. GitHub Actions takes the release version from this tag, runs checks, builds all native targets after tests, publishes and verifies the native assets and `bbx-browser-extension.zip` on GitHub Releases, then publishes npm. It also retains the extension ZIP as an Actions artifact.
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

## Publish release assets and npm

The native publishing manifest contract is:

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
| `win32-arm64` | `bbx-windows-arm64.exe` |
| `win32-x64` | `bbx-windows-x64.exe` |

The wrapper queries GitHub Releases independently of its npm version. By default it installs the latest stable release. `BBX_VERSION` selects an extension release line such as `2.0`, choosing its highest stable patch, or an exact native version. It downloads `https://github.com/koltyakov/browser-bridge/releases/download/v<nativeVersion>/<asset>`, checks the size from GitHub asset metadata and SHA-256 from that release's `checksums.txt`, then runs an isolated executable self-test.

Always run `make package-native-all` after tests to rebuild all six platforms before native publishing. Native publishing calls `scripts/prepare-npm.mjs`, which requires all six expected binary files in `dist/cli`, rejects empty files and files at or above 12,000,000 bytes, then hashes the files and atomically writes `packages/npm/native-manifest.json` for release verification. It does not require a matching npm version. It reads sizes directly from the binaries; there is no separate build report or per-binary version check. Do not commit this generated manifest or bundle it in npm.

The tarball contains only `packages/npm/bin`, `packages/npm/src`, and package metadata/license/docs. Packing requires no native binaries. Go binaries live on GitHub Releases. Shared TypeScript helpers in `protocol/` support browser builds and generation; they are not a published runtime or client library. `npm ci` in a source checkout skips the wrapper bootstrap, so CI does not download a published release during dependency installation.

The release workflow uses Node builtins and `gh` to publish native assets and the extension ZIP. `make publish-release` requires the current version's packaged ZIP and publishes it as `bbx-browser-extension.zip`. It creates a public release if needed, requires the tag to exist, and downloads existing assets to compare their size and digest before uploading missing assets. Uploads never use `--clobber`. A mismatched existing asset fails the release; publish a new version rather than replacing bytes already verified by installations. A pre-existing draft release must be made public before this step. `checksums.txt` continues to cover only the native binaries, and `make publish-native` remains available for native-only publishing.

For a manual fallback, run checks and build the extension first, then:

```bash
make package-native-all
make publish-release
make publish-update-feed
make pack-dry-run
make pack
make publish-npm ARGS=--provenance
```

Authenticate `gh` with permission to create releases in `koltyakov/browser-bridge`. The release tag must already exist remotely. `make package-npm` packs only the launcher and does not build or publish native assets. `make publish-npm` selects the resolved version's tarball; override it with `TARBALL=path` if needed.

The tag workflow publishes npm through trusted publishing with OIDC. The package job uses the `release` environment and `contents: write` for GitHub assets. A dependent npm job downloads that run's tarball and uses `id-token: write` without an environment, preserving the npm publisher's OIDC identity. Neither npm publication nor its job receives the release-signing private key. The workflow retains the npm tarball and extension ZIP as artifacts.

Trusted publishing requires npm CLI `11.5.1+`. The release workflow upgrades npm explicitly before running `npm publish`; if publish fails with `E404` or authentication issues, verify the workflow still prints an npm version at or above that threshold.

## Signed native updates

The release workflow requires signing configuration before building binaries.
It embeds the public keys, publishes immutable binaries, then signs and
publishes `native-updates/stable.json` on a separate prerelease. The prerelease
does not become GitHub's latest stable binary release.

Use the same signing names and scopes as Control and Expose, with BBX's own key:

| Name | Type and scope | Value |
| --- | --- | --- |
| `RELEASE_SIGNING_PUBLIC_KEYS` | Repository variable | JSON map of stable key IDs to base64 raw 32-byte Ed25519 public keys |
| `RELEASE_SIGNING_KEY_ID` | Repository variable | Active key ID, currently `release-2026-11-17` |
| `RELEASE_SIGNING_PRIVATE_KEY` | Secret in the `release` environment | Matching Ed25519 PKCS#8 PEM private key |

Public configuration is available to unsigned builds. Never keep a second copy of
the private key as a repository secret. Control additionally checks the public map
against its reviewed source pins. Keypairs must not be shared between projects.

The `release` environment permits release tags matching `v*.*.*` and the `main`
branch. The branch permission is required for weekly feed renewal and manual
renewal from the default branch. Do not allow all branches or tags. Required
environment approvals also gate renewals; configure them only if someone will
approve the weekly job before the feed expires. npm trusted publishing remains
OIDC-based and independent of this signing key.

- For the first release only, repository variable
  `RELEASE_FEED_INITIALIZE=1`. This creates the metadata prerelease.
  Remove the variable after successful publication. Initialization refuses
  to overwrite an existing metadata release.

Local files live under `~/.ssh/github/`: `bbx.pem` is PKCS#8 private PEM,
`bbx.pub` is SPKI public PEM, and `bbx.json` is the public JSON map.
Control uses the basename `control`; Expose uses `expose`.
For a new key only, generate outside the checkout with Node:

```sh
node --input-type=module -e '
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const directory = join(homedir(), ".ssh", "github");
mkdirSync(directory, {recursive:true,mode:0o700});
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(join(directory, "bbx.pem"), privateKey.export({type:"pkcs8",format:"pem"}), {mode:0o600,flag:"wx"});
writeFileSync(join(directory, "bbx.pub"), publicKey.export({type:"spki",format:"pem"}), {mode:0o644,flag:"wx"});
writeFileSync(join(directory, "bbx.json"), JSON.stringify({"release-2026-11-17":publicKey.export({type:"spki",format:"der"}).subarray(-32).toString("base64")}) + "\n", {mode:0o644,flag:"wx"});
'
```

Keep the directory at mode `0700` and the private key at `0600`. Keep an encrypted
offline backup. Never commit, print, or attach private keys to release artifacts.
Configure GitHub from the files:

```sh
gh secret set RELEASE_SIGNING_PRIVATE_KEY --repo koltyakov/browser-bridge --env release \
  < "$HOME/.ssh/github/bbx.pem"
gh variable set RELEASE_SIGNING_PUBLIC_KEYS --repo koltyakov/browser-bridge \
  --body "$(cat "$HOME/.ssh/github/bbx.json")"
gh variable set RELEASE_SIGNING_KEY_ID --repo koltyakov/browser-bridge --body release-2026-11-17
```

Remove superseded signing secrets and variables after verifying the replacements.
The signer checks that the selected ID's public key matches the private key and
writes that same ID into the feed signature. No `release` alias is required.

`make publish-update-feed` adds the current native release only after
`make publish-release` has verified the public assets. It authenticates the
previous feed before retaining its releases, increases the sequence, and
refuses to change an existing signed version. Only the signed metadata asset
uses `--clobber`; executable assets remain immutable. Publishing jobs share a
concurrency group so scheduled renewal cannot race a release.

The feed expires after 14 days. The weekly `native-update-feed.yml` workflow
renews it without changing binary assets; `make renew-update-feed` does the
same manually. Monitor that workflow. Expired or invalid metadata fails closed
and leaves the installed version selected. Keep both old and new public keys
embedded during signing-key rotation until existing installations can verify
the new feed.

For planned rotation, add the next public key under a new stable ID, publish
bridge binaries trusting both keys while still signing with the old key, then
switch `RELEASE_SIGNING_KEY_ID` and the environment secret. Remove the old public
pin only after installations have crossed the bridge. Never rename an existing
key ID or replace its public key after publication.

Existing binaries without embedded trust and the native identity update hook
need a one-time reinstall. An extension update cannot add updater code to an
older binary. See [native updates](../internal/bridge/README.md#native-updates).

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

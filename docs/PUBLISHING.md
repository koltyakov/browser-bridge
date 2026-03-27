# Publishing Browser Bridge

This repo has two release artifacts:

1. The Chrome extension ZIP for the Chrome Web Store
2. The npm package for the local CLI and native host

The extension is not a standalone product. A store release only becomes usable once the npm package is also published, because the extension depends on the local native host installed by `bbx install <extension-id>`.
The current installer does not embed a store extension ID in the package. Until the code changes, published setup docs should continue to show `bbx install <store-extension-id>` or set `BROWSER_BRIDGE_EXTENSION_ID=<store-extension-id>` before running `bbx install`.

## Release Checklist

1. Bump the version in [package.json](./package.json) and [manifest.json](./manifest.json) together.
2. Run `npm install` if dependencies changed.
3. Run `npm run release:check`.
4. Publish the npm package.
5. Upload the extension ZIP from `dist/browser-bridge-extension-v<version>.zip`.
6. Complete the Chrome Web Store listing, privacy fields, and reviewer instructions.
7. Smoke-test the published extension against the published CLI using `bbx install <store-extension-id>`.

## Build The Extension ZIP

The repo now includes a reproducible packaging step:

```bash
npm run package:extension
```

That stages only the runtime extension files into `dist/browser-bridge-extension/` and writes the upload artifact to:

```bash
dist/browser-bridge-extension-v<version>.zip
```

## Publish The npm Package

The package is configured for public publish:

```bash
npm pack --dry-run
npm publish
```

The published package must stay aligned with the extension release because users still need the final store extension ID at install time unless the installer gains a baked-in default.

## Chrome Web Store Submission

### Store assets you still need to prepare manually

- At least one real product screenshot
- One 440x280 promotional image
- A privacy policy URL
- Support/contact URL or support email in the developer dashboard

The manifest now includes packaged extension icons, but the promo image and screenshots are store-listing assets, not files inside the extension ZIP.

### Single purpose statement

Use one narrow sentence. Suggested draft:

`Browser Bridge lets a local developer agent inspect and patch the currently approved Chrome tab through a local native messaging bridge.`

### Permission justifications

Use reviewer-facing explanations tied to the product purpose:

- `activeTab`: used to bootstrap inspection against the tab the user explicitly enables
- `debugger`: used for Chrome DevTools Protocol reads such as DOM snapshots, computed styles, and element screenshots
- `nativeMessaging`: required to communicate with the local Browser Bridge daemon
- `scripting`: used to inject and coordinate the scoped page instrumentation flow
- `sidePanel`: provides the side panel control surface
- `storage`: persists tab approvals, sessions, and recent UI state
- `tabs`: enumerates tabs and validates that a session still matches the active tab and origin
- `offscreen`: used for screenshot cropping in the offscreen document
- `host_permissions` on `<all_urls>`: needed because the tool is designed to inspect whichever site the user explicitly approves, not a fixed site list

Reviewers will likely scrutinize `debugger`, `nativeMessaging`, and `<all_urls>`. Keep the listing language narrow and explicit about user approval and local-only operation.

### Privacy fields

Current expected answers, assuming you do not add telemetry before release:

- Remote code: `No`
- Data collection: only the page data needed to serve the local user request, transmitted to the local native host on the same machine
- Data sale or transfer: `No`
- Privacy policy: must clearly state what extension data can be read, that approval is tab-scoped, and that the bridge talks to a local process

If product behavior changes, update the privacy answers before submission.

### Reviewer test instructions

Use the Test Instructions tab if the reviewer needs local setup context. Suggested draft:

1. Install the published extension from the draft listing.
2. Install Node.js 18+ on the same machine.
3. Run `npm install -g @browserbridge/bbx`.
4. Run `bbx install <store-extension-id>`.
5. Run `bbx-daemon`.
6. Open any normal web page in Chrome.
7. Open the Browser Bridge popup or side panel and enable Browser Bridge for the current browser window.
8. In a terminal, run `bbx status`, `bbx tabs`, and `bbx page-text`.

Replace `<store-extension-id>` with the final Chrome Web Store extension ID before submitting.

## Post-Publish Follow-Up

- Update [README.md](./README.md) and [QUICKSTART.md](./QUICKSTART.md) with the real store listing URL and the explicit `bbx install <store-extension-id>` flow, unless the installer is updated to embed a default ID.
- Re-run a live flow with `bbx install <store-extension-id>` after the first published build is available.

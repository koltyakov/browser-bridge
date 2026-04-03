# Publishing

This is a maintainer document, not an end-user setup guide. End users should
start with [quickstart](./quickstart.md).

This repo has two release artifacts:

1. The Chrome extension ZIP for the Chrome Web Store
2. The npm package for the local CLI and native host

The extension is not a standalone product. A store release only becomes usable once the npm package is also published, because the extension depends on the local native host installed by `bbx install <extension-id>`.
The published npm package now embeds the Browser Bridge store extension ID, so end-user docs for the published build should default to plain `bbx install`. Only unpacked or non-store builds should require `bbx install <extension-id>` or `BROWSER_BRIDGE_EXTENSION_ID=<extension-id>`.

## Release Checklist

1. Bump the version in [package.json](../package.json) and [manifest.json](../manifest.json) together.
2. Run `npm install` if dependencies changed.
3. Run `npm run release:check`.
4. In npm package settings, add a GitHub Actions trusted publisher for this repository and workflow file `release.yml`.
5. Push the release tag `v<version>` so GitHub Actions publishes the npm package and uploads the extension ZIP artifact.
6. After the first successful trusted publish, set npm package publishing access to require 2FA and disallow tokens, then revoke any old automation token.
7. Upload the extension ZIP from `dist/browser-bridge-extension-v<version>.zip`.
8. Complete the Chrome Web Store listing, privacy fields, and reviewer instructions.
9. Smoke-test the published extension against the published CLI using `bbx install`.

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
npm publish --provenance --access public
```

The release workflow on tag push now performs this publish automatically through npm trusted publishing (OIDC). Manual publish remains a valid fallback when the GitHub workflow is unavailable.

## Chrome Web Store Submission

### Store assets you still need to prepare manually

- At least one real product screenshot
- One 440x280 promotional image
- A privacy policy URL
- Support/contact URL or support email in the developer dashboard

The manifest now includes packaged extension icons, but the promo image and screenshots are store-listing assets, not files inside the extension ZIP.

### Single purpose statement

Use one narrow sentence. Suggested draft:

`Browser Bridge lets a local developer agent inspect and patch web pages in an explicitly enabled Chrome window through a local native messaging bridge.`

### Permission justifications

Use reviewer-facing explanations tied to the product purpose:

- `activeTab`: used to bootstrap inspection against the tab the user explicitly enables
- `debugger`: used for Chrome DevTools Protocol reads and page-context evaluation, such as DOM snapshots, computed styles, screenshots, accessibility data, and page inspection helpers
- `nativeMessaging`: required to communicate with the local Browser Bridge daemon
- `scripting`: used to inject and coordinate the scoped page instrumentation flow
- `sidePanel`: provides the side panel control surface
- `storage`: persists window approvals, session state, and recent UI state for the current browser session
- `tabs`: enumerates tabs and validates that a request stays inside the enabled window
- `offscreen`: used for screenshot cropping in the offscreen document
- `host_permissions` on `<all_urls>`: needed because the tool is designed to inspect whichever site the user explicitly approves, not a fixed site list

Reviewers will likely scrutinize `debugger`, `nativeMessaging`, and `<all_urls>`. Keep the listing language narrow and explicit about user approval and local-only operation.

### Privacy fields

Current expected answers with the code as it exists today:

- Remote code: do not default this to `No`. Browser Bridge can execute user-requested expressions in page context through the Chrome Debugger API. Answer this honestly in the dashboard and explain that the extension does not load remote-hosted extension scripts.
- Data collection: disclose the page data the product can access for the enabled window, including browsing/page content, DOM/style/layout data, console output, network metadata, storage values when requested, and screenshots when requested
- Data sale: `No`
- Data handling: Browser Bridge itself routes data locally to the native host and connected local client; a connected agent or IDE may still forward data onward under its own policy
- Privacy policy: must clearly state what data the extension can access, that approval is window-scoped, and that Browser Bridge itself does not operate a Browser Bridge cloud service

If product behavior changes, update the privacy answers before submission.

### Reviewer test instructions

Google marks the Test Instructions tab as optional, but Browser Bridge should still provide it because the product depends on local CLI/native-host setup. Suggested draft:

1. Install the published extension from the draft listing.
2. Install Node.js 18+ on the same machine.
3. Run `npm install -g @browserbridge/bbx`.
4. Run `bbx install`.
5. If needed, run `bbx-daemon`.
6. Open any normal web page in Chrome.
7. Open the Browser Bridge popup or side panel and enable Browser Bridge for the current browser window.
8. In a terminal, run `bbx status`, `bbx tabs`, and `bbx page-text`.

## Post-Publish Follow-Up

- Update [README.md](../README.md) and [quickstart.md](./quickstart.md) with the real store listing URL.
- Re-run a live flow with `bbx install` after the first published build is available.

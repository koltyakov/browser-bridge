# Unpacked Extension Install

Use this path while the Chrome Web Store listing is still pending, or anytime
you want to run Browser Bridge without installing it from a marketplace.

## 1. Install the CLI

```bash
npm install -g @browserbridge/bbx
```

## 2. Build the unpacked extension bundle

From this repository, stage the extension files into `dist/`:

```bash
npm run package:extension
```

That writes the unpacked extension to:

```text
dist/browser-bridge-extension/
```

## 3. Load it into Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `dist/browser-bridge-extension`.

## 4. Copy the extension ID

After Chrome loads the unpacked extension, copy its extension ID from the
Extensions page.

## 5. Install the native host for that extension ID

Unpacked builds do not use the published store ID, so install the native host
manifest explicitly for the loaded extension:

```bash
bbx install <extension-id>
```

You can also provide the same value through the environment if needed:

```bash
BROWSER_BRIDGE_EXTENSION_ID=<extension-id> bbx install
```

## 6. Verify the local connection

```bash
bbx status
bbx doctor
```

Then open the Browser Bridge side panel in Chrome, enable access for the target
window, and verify the bridge is responding:

```bash
bbx call page.get_state
```

## Notes

- Re-run `bbx install <extension-id>` if you switch to a different unpacked
  extension build with a different ID.
- For packaged store builds, plain `bbx install` is the intended path once the
  Chrome Web Store release is live.

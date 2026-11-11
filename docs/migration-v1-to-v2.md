# Migrate from v1 to v2

Browser Bridge v2 replaces the Node.js CLI, daemon, native messaging host, and
MCP server with one Go executable. The `bbx`, `bbx-daemon`, `bbx-install`, and
`bbx-mcp` commands remain available. Normal MCP and CLI workflows still use
the same bridge methods, but scripts that import JavaScript internals or parse
CLI output need review.

This guide targets v2.1.0 and later `2.1.x` patches. You can upgrade directly
from v1 without installing v2.0 first. Update both the browser extension and
the local runtime. Updating only the npm package does not update the extension.

## Before upgrading

- Finish any running browser actions. An existing MCP process keeps its loaded
  runtime until restarted, and an interrupted action may already have taken effect.
- Back up hand-edited MCP configurations and customized Browser Bridge skills.
  Keep the existing bridge data directory, credentials, and browser registrations;
  migration does not require deleting them.
- Note your browser and extension ID if you use an unpacked or custom build.
  The default installers detect the Chrome Web Store extension in supported
  browsers and refresh existing native registrations.

## 1. Update the extension

Update [Browser Bridge in the Chrome Web Store](https://chromewebstore.google.com/detail/browser-bridge/jjjkmmcdkpcgamlopogicbnnhdgebhie).
For an unpacked build, follow the [unpacked extension guide](./unpacked-extension.md).
Open the side panel and use its setup command to select the matching native
release line.

The v1.15 transition release advertises protocol 2.0 and accepts v1 peers. Its
automatic npm upgrade path selects v2 only after the v2 extension is present;
the v1.15 extension stays on the Node runtime. Explicit update opt-outs remain
respected. You can migrate manually from an older v1 release using the steps
below without first installing v1.15.

## 2. Replace the local runtime

Choose one installation method. The examples select the newest stable `2.1.x`
release, starting with v2.1.0. Replace `2.1` with the release line shown in your
extension's setup panel if it is newer. A missing matching release causes
installation to fail rather than silently choosing another line.

### Recommended: standalone installer

No Node.js, npm, or Go installation is needed. On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.sh | BBX_VERSION=2.1 sh
```

On Windows, run in PowerShell:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/koltyakov/browser-bridge/main/scripts/install.ps1'))) -Version '2.1'
```

The installer verifies the release checksum, installs to `~/.local/bin`,
registers supported browsers where the extension is detected, and restarts the
daemon. It also tries to remove the old
global `@browserbridge/bbx` npm package so its launchers do not shadow the new
CLI. If that fails, follow the installer's warning to remove the old package.
Do not remove Node.js if other tools still need it.

v2.1.0 adds native Windows ARM64 support alongside Windows x64, macOS
arm64/x64, and Linux arm64/x64. The installer selects your architecture.

Keep `~/.local/bin` on your shell's `PATH` on macOS and Linux. Windows updates
your user `PATH`; open a new terminal afterward. For another browser, custom
extension ID, or installation directory, use the [installer options](./native-cli.md#install-without-nodejs).

### Alternative: keep npm

With Node.js 20 or later, update the global package. On macOS or Linux:

```sh
BBX_VERSION=2.1 npm install -g @browserbridge/bbx@latest
```

On Windows, run in PowerShell:

```powershell
$env:BBX_VERSION = '2.1'
npm install -g @browserbridge/bbx@latest
Remove-Item Env:BBX_VERSION
```

The v2 npm package downloads and verifies a native GitHub release independently
of the npm package version. `BBX_VERSION` selects the native release, not an npm
version suffix. Without it, installation selects the latest stable native
release and does not detect your extension version automatically.

A global install runs browser registration. If npm install scripts were skipped,
run `bbx install` afterward. npm remains the update manager for this installation;
the native signed updater does not replace npm's selected executable. See the
[native CLI guide](./native-cli.md#versions-and-updates).

## 3. Refresh agent setup

`bbx install` repairs recognized global Browser Bridge MCP entries, including
the removed `packages/mcp-server/src/bin.js` entrypoint, npm/Node launchers,
and older native paths. It writes the absolute, symlink-resolved Go executable
with arguments `mcp serve`, preserving environment variables and client settings.
Custom wrappers and remote transports are not automatically replaced.

If your browser is still disconnected, rerun registration for that browser:

```sh
bbx install --browser chrome
```

Use your actual browser target, such as `edge`, `brave`, `chromium`, or `arc`.
For an unpacked extension, use the registration command in its side panel so
the correct extension ID is allowed.

For MCP, rewrite any remaining stale entry with your client target:

```sh
bbx install-mcp codex
```

Replace `codex` with your [supported client](./manual-setup.md#3-managed-setup-for-supported-clients).
Project-local configurations are not scanned during the global upgrade. Run
this in each repository that has a local MCP configuration:

```sh
bbx install-mcp codex --local
```

If you use the CLI skill instead of MCP, refresh it with `bbx install-skill codex`,
or `bbx install-skill codex --local` for a project installation. Review customized
skill files before refreshing them. MCP does not require a separate CLI skill.

Restart your agent or IDE after updating its configuration. This is especially
important for MCP sessions that still have the v1 Node server loaded.

## 4. Restart and verify

```sh
bbx --version
bbx restart
bbx doctor
bbx status
```

Reload the extension in each browser/profile you use. Enable access again if
needed, then run `bbx tabs` to confirm that your intended tab is available.
Rediscover connection IDs after reconnecting rather than reusing old ones.

`bbx --version` should report v2.1.0 or a newer `2.1.x` patch. Doctor should
report a compatible daemon and extension, with no missing MCP launch files.
A successful health response alone does not prove protocol compatibility.
v2 normally requires matching protocol majors; v1.15 is the transition
exception, not a guarantee for older v1 peers.

If an action was interrupted during migration, inspect the page before trying
it again. Migration does not replay browser actions.

### Review v2.1 access settings

The side panel now lets you grant access to the current tab and tabs agents
create, rather than every tab in the window. Closing the granted tab revokes
that access. Choose the scope your workflow needs before continuing.

Review the persistent access settings if existing automation stops working:

- Agents can create tabs by default, but cannot close user tabs.
- Direct navigation of an existing page to a different hostname is blocked by
  default. This restriction does not block page links or redirects.
- AI-created tabs close when access ends unless automatic cleanup is disabled.
  Save any results you need before revoking access.

Adjust these settings explicitly in the side panel instead of retrying a
blocked action. If cleanup is incomplete, the side panel reports it separately
from access being disabled.

## Changes for scripts and custom integrations

- The npm package no longer ships the v1 JavaScript runtime or a JavaScript
  client API. Replace imports of internal files, including `BridgeClient`
  usage, with `bbx call`, MCP, or an authenticated wire client. The
  [CLI and wire API reference](./api-reference.md) documents request framing,
  registration, credentials, and response envelopes.
- Shortcut JSON drops `summaryBytes`, `summaryTokens`, `summaryCostClass`,
  `transportBytes`, and `transportCostClass`. `transportTokens` appears only
  above the cheap tier of 250 tokens. Treat these accounting fields as optional.
- Timing omits zero `preparationMs` and `queueMs`, and omits `scheduled: false`.
  Batch and MCP output also omit empty or repeated metadata.
- A failed `bbx call` prints `{ok, error, recovery}`, with `meta` only when
  needed for diagnostics. Do not require a request ID, `result: null`, or the
  full transport envelope in CLI error output. Parse `ok` and `error` instead.
- MCP DOM queries omit bounding boxes unless `includeBbox: true` is set.
  MCP geometry can be rounded, and accessibility trees omit empty strings and
  false flags. Do not treat an omitted optional field as a failed request.
- Put routing fields at the documented request level. For example, use
  `bbx call --tab 123 page.get_state '{}'`, not a `tabId` inside method params.

See the [v2.1.0 changelog](../CHANGELOG.md#210---2026-11-08) for access changes and
platform support, and the [v2.0.0 changelog](../CHANGELOG.md#200---2026-11-08) for
the runtime replacement and output changes. Use [troubleshooting](./troubleshooting.md#the-mcp-server-fails-to-start-after-upgrading-to-v2)
if an agent still tries to start a removed Node entrypoint.

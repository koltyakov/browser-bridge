# Install the Browser Bridge companion

The companion includes its own runtime. You do not need Node, npm, or Bun.

## First-time setup

1. Install the Browser Bridge extension from the Chrome Web Store.
2. Download the companion from the extension.
3. On macOS, unzip and open **Browser Bridge**. On Windows, open **Browser-Bridge-Setup.exe**.
4. Return to the extension. It reconnects automatically.
5. Choose your agent under **Connect your agent**, then enable window access.

The macOS setup app installs into your user account. You can remove the downloaded setup app afterward. Setup does not require administrator access.

Linux and terminal installations use the release installer:

```sh
curl -fsSL https://github.com/koltyakov/browser-bridge/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/koltyakov/browser-bridge/releases/latest/download/install.ps1 | iex
```

Linux binaries target glibc distributions. Sandboxed Snap/Flatpak browsers require separate native-messaging support. Use a regular Chrome installation for the supported setup path.

## Moving from npm

Run the same installer. There is no uninstall-first step.

Setup retains the Browser Bridge data directory, access settings, remote destinations, custom extension origins and existing agent configuration. It switches registered browsers and recognized user-level MCP entries to an absolute companion path. Other MCP servers and Browser Bridge environment variables and flags remain intact. Backups are stored under `companion/backups` in the Browser Bridge data directory.

Restart existing agents once after migration. The npm package can remain installed. New npm entrypoints forward to the companion, and their postinstall hook no longer overwrites companion registration. Versions released before companion support cannot forward; their already-running MCP processes need a restart. Future npm reinstalls of those old versions can overwrite registration; rerunning companion setup repairs it.

Project-specific configurations outside known user settings are not scanned across your disk. Migrate a project explicitly with `bbx setup --project /path/to/project`, using the companion executable. Custom wrappers and unrecognized commands remain unchanged. Invalid agent configuration stops setup before changes are made.

## Updates and repair

New installations enable compatible automatic updates. Existing explicit update preferences are preserved. The companion checks GitHub once a day when no agents are connected, verifies a signed manifest and executable digest, and keeps the previous binary. An update worker installs and restarts the daemon. Connected agents postpone background checks. `bbx update` installs and restarts immediately; `bbx rollback` restores the previous version and blocks that release from automatically reinstalling. Both commands use the companion executable.

Extension and companion patch/minor versions may differ. Automatic updates stay within the supported protocol major version. A major protocol change requires a coordinated installer/extension upgrade.

Run the installer again to repair registration. If an update cannot download or verify, the existing installation keeps working.

## Maintainer build and release

`npm run package:standalone` uses Bun at build time to produce a single executable with the runtime, JavaScript dependencies and skill files embedded. End users need none of the build tools. These are self-contained executables, not a promise of fully static OS linkage.

Targets are macOS arm64/x64, Windows x64 baseline, and Linux arm64/x64 baseline. CI builds and smoke-tests native binaries before release. `scripts/package-macos.mjs` produces the setup app; `scripts/companion.nsi` produces the Windows installer.

Production release configuration requires an Ed25519 update key pair. Store `BBX_UPDATE_PRIVATE_KEY` as a GitHub secret and `BBX_UPDATE_PUBLIC_KEY` as a repository variable. The public key is embedded in every binary. Updates cannot run when a build lacks it. Keep the signing key stable across releases; rotating it requires a separate trust transition.

macOS signing uses `MACOS_SIGN_IDENTITY` and an installed signing certificate; notarization uses `MACOS_NOTARY_PROFILE`. Windows signing must sign both the executable and the installer with the publisher certificate before generating update hashes. Unsigned development packages do not provide the intended first-run experience. The release workflow refuses publication unless platform signing and update-signing configuration are present.

Configure these GitHub repository settings before tagging the first companion release:

| Setting | Storage | Value |
| --- | --- | --- |
| `BBX_UPDATE_PUBLIC_KEY` | Variable | Ed25519 public key in PEM format |
| `BBX_UPDATE_PRIVATE_KEY` | Secret | Matching private key in PEM format |
| `MACOS_SIGN_IDENTITY` | Variable | Developer ID Application signing identity |
| `MACOS_SIGN_P12` | Secret | Base64-encoded signing certificate and private key |
| `MACOS_SIGN_PASSWORD` | Secret | Password for that P12 |
| `APPLE_ID` | Secret | Apple developer account email |
| `APPLE_APP_PASSWORD` | Secret | App-specific notarization password |
| `APPLE_TEAM_ID` | Variable | Apple developer team ID |
| `WINDOWS_SIGN_PFX` | Secret | Base64-encoded Windows publisher certificate and private key |
| `WINDOWS_SIGN_PASSWORD` | Secret | Password for that PFX |

The workflow creates the temporary macOS keychain and notarization profile. Both platform installers must succeed before npm or companion assets are published. Signing certificates and release credentials are not generated or installed by the build scripts.

Stable launchers live in the per-user Browser Bridge `companion` directory, with versioned payloads under `versions`. MCP and native messaging use absolute paths. Setup adds the companion directory to the Windows user PATH or marked blocks in Bash/Zsh startup files, preserving the rest of those files and saving backups. Restart existing terminals once. The `bbx`, `bbx-mcp`, `bbx-daemon`, and `bbx-install` commands then work without Node. Set `BBX_NO_PATH=1` before setup to manage PATH yourself.

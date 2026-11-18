# Browser installation and compatibility

## Verification on November 15, 2026

The installer changes were tested on Beelink, Windows 11 x64; Ubuntu 26.10 x64;
and macos-parallels, macOS 27.2 on Apple Silicon. These results describe the
development build `2.1.2-dev.372cd828`, not a published release.

A full pass means the shipped extension connected through the real native host
and Go daemon, enabled access in a disposable fixture window, returned page text
and a DOM query through the CLI, performed a CDP mouse click with a verified page
change, and recovered after native-host reinstallation without enabling access
again. Ubuntu tests used new headless mode. Windows and macOS used headed
browsers unless stated otherwise.

| Browser | Beelink | Ubuntu | macos-parallels |
| --- | --- | --- | --- |
| Chrome Stable | Full pass | Full pass | Full pass |
| Chrome Beta | Full pass | Full pass | Full pass |
| Chrome Dev | Full pass | Full pass | Full pass |
| Chrome Canary | Full pass | Full pass | Full pass |
| Brave | Full pass | Full pass | Full pass |
| Microsoft Edge | Full pass | Full pass | Blocked by macOS directory access and startup |
| Opera | Full pass | Package dependencies unavailable | Full pass |
| Vivaldi | Native lookup verified; fixture UI stalled | Full pass | Native lookup verified; fixture UI stalled |
| Chrome for Testing | Native lookup verified; fixture navigation did not commit | Startup blocked by AppArmor user-namespace restrictions | Official archive failed bundle-signature verification; not run |
| Chromium | Not separately installed | Strict Snap host exited before connecting | Homebrew cask disabled because of Gatekeeper failures |
| Arc | Not tested | No installation attempted | Native lookup and BBX 2.2.0 connection verified with a disposable home; browser actions not tested |

There were 20 full browser/platform passes. Reinstallation and reconnection
took 2.08–2.60 seconds in these single-fixture runs. These are recovery samples,
not a latency benchmark or a soak test.

The optimized development binary was then installed globally on all three
machines, with backups of the previous executables. Native-host registration
added the public extension ID while preserving existing origins. A final Canary
check using each installed binary passed page reads, DOM queries, CDP clicks,
and reinstall recovery. Reconnection took 2.17–2.31 seconds.

Helium 0.10.2.1 on macOS also passed a separate native-host, page-read, DOM-query,
and CDP-click smoke test through Chrome's native-host fallback. There is no named
`helium` installation target, and reinstall recovery was not tested for it.

### Versions

- Chrome Stable was 157.0.8103.78 on Windows/Ubuntu and 157.0.8103.39 on macOS.
- Beta was 159.0.8154.6; Dev was 160.0.8157.0.
- Canary was 160.0.8162.0 on Windows and 160.0.8163.0 on macOS/Ubuntu.
- Edge was 157.0.4341.60 on Windows/Ubuntu.
- Vivaldi was 8.3.4191.44, using Chromium 156.0.8078.104.
- Opera was 140.0.6074.18 on Windows and 139.0.6053.38 on macOS.
- Chrome for Testing was 157.0.8103.78. Snap Chromium was 157.0.8103.50.

## What changed

- Chrome Beta, Dev, Canary, and Chrome for Testing have explicit installation
  targets and automatic discovery in their standard profile directories.
- Vivaldi and Opera have installation targets. Opera discovery handles roaming
  application data on Windows and root-level extension metadata.
- Windows Chrome Stable/Beta/Dev/Canary use the Google Chrome registry key.
  Brave, Chromium, Arc, Chrome for Testing, Vivaldi, and Opera use the Chromium
  key before falling back to Chrome. Registering an unrelated Brave-specific key
  does not configure the tested Brave build.
- Shared registrations retain consumer ownership and existing extension origins.
  Removing one registered consumer preserves the remaining consumers' host.
  Windows migration also retains origins from older per-browser manifests.
- macOS Brave and Opera use Chrome's native-host directory. Linux Brave keeps
  its default native-host lookup even with a custom browser user-data directory.
- `bbx install --browser <target> --user-data-dir <path>` registers custom
  user-data roots without guessing a running browser's filesystem paths.

Unique disposable native hosts identified actual lookup locations and fallback
order. Those probes did not replace the Browser Bridge host and were removed
after each check.

### Multiple profile roots

Discovery inspects both native and Snap Chromium profile roots when no explicit
config-directory override is set. If both roots exist, installation, repair,
diagnostics, and uninstallation handle both native-host manifests. Automatic
repair preserves each manifest's origins independently. This does not fix the
strict Snap launcher-execution limitation described below.

Windows Arc discovery also checks matching `TheBrowserCompany.Arc_*` MSIX
packages under `%LOCALAPPDATA%\Packages`, including their
`LocalCache\Local\Arc\User Data` profiles. These are discovery locations only:
Arc still uses one shared Chromium registry registration, not a registration per
package or profile.

An explicit `--user-data-dir` restricts profile discovery to that root. Fixed
native-host lookup directories and Windows registry ownership remain unchanged.
`CHROME_CONFIG_HOME` and absolute `XDG_CONFIG_HOME` overrides retain their scoped
Linux behavior instead of also registering the default Snap location.

### Arc endpoint finding corrected

The original macOS Arc result was an endpoint-discovery failure, not evidence
that Arc failed to expose DevTools. Arc 1.172.1 logged a loopback WebSocket
endpoint. Its default
`~/Library/Application Support/Arc/User Data/DevToolsActivePort` contains the
same port and browser ID. The runner only checked
`<disposable-profile>/DevToolsActivePort`; that requested profile stayed empty.
It timed out before attempting a WebSocket connection or native-host probe.
The supplied `--user-data-dir=<path>` did not redirect Arc's data root in this
run.

A follow-up on vm.macos redirected both `HOME` and `CFFIXED_USER_HOME`. Arc
created `Local State` under the disposable home's `Arc/User Data`, but did not
listen for DevTools. A process sample showed it waiting in macOS Keychain
calls, and the system log recorded error `-25307` (no default keychain).
With `--use-mock-keychain --password-store=basic`, Arc opened a loopback
listener and wrote a fresh `DevToolsActivePort` in that same disposable root.

Arc did not find the native host under `Arc/User Data/NativeMessagingHosts`.
A nonce-tagged reply proved lookup and execution from
`Google/Chrome/NativeMessagingHosts` inside the disposable home. Using that
directory, the published BBX 2.2.0 binary and a private-ID copy of the release
ZIP reported `extensionConnected: true` through `health.ping`. This verifies
native messaging, not browser actions, store install, or `bbx install --browser
arc`, which still targets the Arc data directory on macOS.

The maintained opt-in Arc runner now checks fresh startup-log endpoints and
new port files, verifies the actual isolated data root before connecting, and
reports discovery, isolation, HTTP/WebSocket connection, manifest creation,
native-host lookup, and bridge connection separately. It never silently
attaches to a real default profile when the requested disposable root is
ignored. See [live verification](../tests/live/README.md) for
`make test-arc-live` and its focused, browser-free regression tests.

## Limits and remaining checks

Full passes used disposable user-data directories. Default channel registration
paths were checked in unit tests and written during live setup. A separate
attempt to create disposable profiles inside the macOS default data roots was
denied by macOS privacy protection, so that default-root launch check did not
complete. Existing personal profiles were not used for fixture actions.

Vivaldi's full flow remains unverified on Windows/macOS. The extension worker
and native-host lookup worked, but the test controller could not finish loading
its fixture UI there, including a headless follow-up. Chrome for Testing on
Windows similarly reached its extension context and native host, but its
loopback fixture remained uncommitted. These are not full passes.

The Ubuntu Opera package required unavailable Qt5 package names. Strict Snap
Chromium found a native-host manifest but the BBX host exited before connecting.
Neither case was worked around by disabling the browser sandbox. Gatekeeper,
AppArmor, and macOS privacy protections were not disabled.

Installation targets are not runtime browser identities. Chrome channels
normally report `chrome`; use distinct BBX profile labels or an explicit
connection ID when several channels are open. See the [CLI guide](./cli-guide.md).

See the [quickstart](./quickstart.md) for channel and custom-directory commands,
and [troubleshooting](./troubleshooting.md) for permission and sandbox failures.

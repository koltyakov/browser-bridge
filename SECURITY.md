# Security Policy

Browser Bridge gives coding agents structured access to a real browser profile. The daemon,
native messaging host, Chrome extension, CLI, and MCP server are all part of the trusted
path between an agent and the user's browser, so security reports are taken seriously.

## Supported Versions

Only the latest version published to npm (`@browserbridge/bbx`) and the Chrome Web Store
receives security fixes. Older versions are not patched retroactively; upgrade to the
latest release before reporting.

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's security advisory form:
<https://github.com/koltyakov/browser-bridge/security/advisories/new>

Include the affected component (daemon, native host, extension, CLI, MCP server), a
reproduction, and the impact you believe it has. Reports are acknowledged as quickly as
possible; fixes for confirmed vulnerabilities are prioritized over regular development.

## Scope

In scope:

- The bridge daemon: transport auth (socket permissions, TCP auth token), request routing,
  and the opt-in proxy/remote mode.
- The native messaging host and its manifest installation.
- The Chrome extension (MV3 service worker, content scripts, CDP usage).
- The `bbx` CLI and MCP server, including config/skill installation paths.

Out of scope:

- Vulnerabilities in Chrome, Node.js, or other dependencies (report upstream).
- Issues requiring an already-compromised machine or browser profile.
- The inherent capability of the tool itself: an agent authorized to use Browser Bridge
  can, by design, read and manipulate pages in the connected browser profile. See
  [PRIVACY.md](https://github.com/koltyakov/browser-bridge/blob/main/PRIVACY.md) and
  [docs/agent-permissions.md](https://github.com/koltyakov/browser-bridge/blob/main/docs/agent-permissions.md)
  for the intended trust model.

## Design Notes

- By default the daemon listens on a user-owned Unix socket (mode `0700` directory) or,
  on Windows, a named pipe / localhost TCP.
- Any TCP listener requires a random 256-bit auth token stored with mode `0600`;
  registration without it is rejected and the comparison is constant-time.
- Proxy mode (LAN exposure) is opt-in via `bbx proxy enable` and always provisions a
  token; an invalid `bindHost` in the config rejects the config rather than widening
  the bind address.

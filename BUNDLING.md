# Bundling Strategy

## Current Architecture

```
Chrome Extension ←→ Native Host (Node.js) ←→ Daemon (Node.js) ←→ CLI (Node.js)
```

Everything runs on Node.js. The native host is a shell launcher that execs Node.

## Zig Daemon: Rationale

The bridge daemon (`packages/native-host/src/daemon.js`) is a simple Unix socket server that routes JSON messages. It's an ideal candidate for a Zig rewrite:

| Aspect         | Node.js Daemon               | Zig Daemon                      |
| -------------- | ---------------------------- | ------------------------------- |
| Binary size    | ~50MB (Node runtime)         | ~200KB static binary            |
| Startup time   | ~100ms                       | ~1ms                            |
| Memory         | ~30MB RSS                    | ~2MB RSS                        |
| Cross-platform | Requires Node installed      | Single static binary per target |
| Distribution   | npm install + shell launcher | Drop binary in PATH             |

### Zig Targets

```bash
zig build -Dtarget=x86_64-macos     # macOS Intel
zig build -Dtarget=aarch64-macos    # macOS Apple Silicon
zig build -Dtarget=x86_64-linux     # Linux x86_64
zig build -Dtarget=x86_64-windows   # Windows
```

### Implementation Scope

The daemon is ~350 lines of JS with this core logic:

1. Listen on Unix socket (or named pipe on Windows)
2. Accept connections, read JSON lines
3. Route `register` → track as extension or agent socket
4. Route `agent.request` → forward to extension socket
5. Route `extension.response` → forward to matching agent socket
6. Buffer last 200 log entries
7. Handle disconnections gracefully

This maps cleanly to Zig's `std.net.Stream` + `std.json` + `std.ArrayList`.

### Native Host Bootstrap

The native host (`native-host.js`) could also be Zig — it does:

1. Read 4-byte length-prefixed JSON from stdin (Chrome native messaging format)
2. Forward to daemon socket as JSON lines
3. Forward daemon responses back as length-prefixed JSON on stdout
4. Bootstrap daemon if socket unavailable

A Zig native host eliminates the shell launcher entirely. Chrome starts the binary directly.

## Recommended Approach

### Phase 1: Keep Node for Development (current)

- `npx bb daemon` starts the Node daemon
- `npx bb install <ext-id>` installs shell launcher + manifest
- Full development flexibility, easy debugging

### Phase 2: Zig Daemon Binary

- Create `packages/native-host-zig/` with Zig source
- Build static binaries for macOS (arm64/x86_64), Linux (x86_64), Windows (x86_64)
- `install-manifest.js` detects compiled binary and points manifest directly at it
- Fall back to Node launcher if no binary found

### Phase 3: Zig Native Host

- Combine daemon + native host into one Zig binary with subcommands:
  - `bb-native daemon` — run standalone daemon
  - `bb-native host` — run as Chrome native messaging host (auto-starts daemon)
  - `bb-native install <ext-id>` — install manifest pointing to self
- Single ~200KB binary replaces shell launcher, Node daemon, and Node native host

### Phase 4: Extension Bundling

- The Chrome extension cannot bundle the daemon (different security contexts)
- But the extension _can_ ship with the Zig binary in the extension directory
- `install-manifest.js` would point Chrome's manifest at the binary inside the extension dir
- This eliminates the separate daemon install step

## Extension Cannot Import Daemon

Chrome extensions run in sandboxed contexts. The extension cannot:

- Start native processes directly (only via `chrome.runtime.connectNative`)
- Bundle executable code that runs outside the extension sandbox
- Share memory with the daemon

The native messaging manifest is the only bridge. The daemon must be installed separately.

However, the extension _zip_ could include the daemon binary alongside extension files, and the install-manifest command could reference it there. This gives a "single download" experience.

## Build Integration

```jsonc
// package.json additions for Phase 2+
{
  "scripts": {
    "build:daemon": "cd packages/native-host-zig && zig build -Doptimize=ReleaseSmall",
    "build:daemon:all": "cd packages/native-host-zig && zig build -Dtarget=aarch64-macos -Doptimize=ReleaseSmall && zig build -Dtarget=x86_64-macos -Doptimize=ReleaseSmall && zig build -Dtarget=x86_64-linux -Doptimize=ReleaseSmall",
  },
}
```

## Decision Matrix

| Question                        | Answer                                                 |
| ------------------------------- | ------------------------------------------------------ |
| Rewrite daemon in Zig?          | Yes — clear wins on size, startup, portability         |
| Rewrite CLI in Zig?             | No — CLI needs Node for protocol/budget JS code reuse  |
| Rewrite native host in Zig?     | Yes — combine with daemon for single binary            |
| Bundle Zig binary in extension? | Possible but install step still needed for manifest    |
| Keep Node fallback?             | Yes — for development and platforms without Zig binary |

# Remote proxy: drive a browser on another machine

Browser Bridge normally connects your agent to Chrome on the same machine. The remote proxy
flow lets an agent on a dev machine drive a browser that runs somewhere else — a Windows VM,
a machine on a private test network, or a teammate's box during pairing.

```
Dev machine                              Browser machine (VM, lab box, ...)
┌─────────────────────────┐              ┌──────────────────────────────────┐
│ Agent / MCP / bbx CLI   │── TCP+token ─▶ bbx daemon (proxy mode) ── Chrome │
└─────────────────────────┘              └──────────────────────────────────┘
```

Remote access is **opt-in, token-authenticated, and visible**: the extension side panel shows
a warning banner while the daemon accepts remote connections.

## 1. Enable proxy mode on the browser machine

On the machine that runs Chrome with the Browser Bridge extension:

```bash
bbx proxy enable --port 9223
```

This binds the local daemon to `0.0.0.0:9223` (override with `--bind-host`), generates an auth
token, and prints the exact `bbx remote add` command for the other side.

Re-running `bbx proxy enable` is **idempotent**: it reuses the existing port, bind host, and
token, so already-configured clients keep working. Flags you pass explicitly override the stored
values; the secret only changes when you ask for it:

```bash
bbx proxy enable                  # safe to re-run — settings and token unchanged
bbx proxy enable --port 9444      # change the port, keep the token
bbx proxy enable --rotate-token   # generate a new secret (re-add on every client)
bbx proxy status                  # config, bind address, and daemon reachability
bbx proxy disable                 # remove the config and restart the daemon on local-only transport
```

While proxy mode is on, the extension side panel displays a "Remote proxy is on" banner with
the bind endpoint, so exposure is never silent.

> Proxy mode does not change what the extension can do or which permissions it needs. It only
> lets authenticated agents reach the same daemon over TCP instead of the local socket.

## 2. Register the remote on the dev machine

```bash
bbx remote add vm-private 192.168.56.20:9223 --token <token-from-step-1>
bbx remote test vm-private        # health.ping through the proxy
bbx remote list                   # configured remotes (tokens are never printed)
bbx remote remove vm-private      # forget it
```

Port `9223` is assumed when omitted. Credentials are stored with `0600` permissions in
`remotes.json` under the Browser Bridge data directory.

## 3. Use it from the CLI

Every bridge command accepts a global `--remote <name>` flag:

```bash
bbx status --remote vm-private
bbx tabs --remote vm-private
bbx dom-query "#app" --remote vm-private
bbx call page.get_state '{}' --remote vm-private
bbx screenshot "#hero" --remote vm-private
```

For a whole session against the same remote, set the environment variable instead:

```bash
export BBX_REMOTE=vm-private
bbx tabs          # now targets vm-private
```

Local-only commands (`install`, `proxy`, `remote`, `doctor`, `restart`, `mcp`, ...) reject
`--remote` and ignore `BBX_REMOTE`, since they manage the machine they run on.

## 4. Use it from MCP

MCP tools take an optional `destinationId` parameter:

- `browser_status` lists all destinations (`local` plus each configured remote) with
  reachability, so agents can discover what is available.
- Pass `destinationId: "vm-private"` on `browser_tabs`, `browser_dom`, `browser_page`,
  `browser_input`, `browser_call`, and the rest to route a single call to the remote browser.
- `browser_batch` accepts `destinationId` per call, so one batch can mix local and remote reads.
- When the local bridge is offline and remotes are configured, tool calls automatically fall
  back to the first reachable remote and report `autoSelectedDestinationId` in the result.

## Troubleshooting

| Symptom | Check |
|---|---|
| `bbx remote test` not reachable | Firewall allows the port; `bbx proxy status` on the browser machine says the daemon is reachable |
| `Bridge daemon authentication failed` | Token mismatch — re-run `bbx proxy enable` and re-add the remote with the printed token |
| Reachable but `extension not connected` | Chrome with the Browser Bridge extension isn't running on the remote machine, or `bbx install` wasn't run there |
| Access denied on remote calls | Window access must be enabled in the remote browser's extension popup/side panel |

Related: [Quickstart](./quickstart.md) · [CLI guide](./cli-guide.md) · [Troubleshooting](./troubleshooting.md)

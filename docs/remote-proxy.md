# Remote proxy: drive a browser on another machine

Browser Bridge normally connects your agent to Chrome on the same machine. The remote proxy
flow lets an agent on a dev machine drive a browser that runs somewhere else - a Windows VM,
a machine on a private test network, or a teammate's box during pairing.

```
Dev machine                                  Browser machine (VM, lab box, ...)
┌─────────────────────────┐                  ┌──────────────────────────────────┐
│ Agent / MCP / bbx CLI   │── SSH tunnel ──▶│ bbx daemon (loopback) ── Chrome  │
└─────────────────────────┘                  └──────────────────────────────────┘
```

Remote access is **opt-in, token-authenticated, and visible**: the extension side panel shows
a warning banner while the daemon accepts remote connections.

## 1. Enable proxy mode on the browser machine

On the machine that runs Chrome with the Browser Bridge extension:

```bash
bbx proxy enable --port 9223
```

This binds the daemon to `127.0.0.1:9223`, generates an auth token, and prints the SSH
local-forward and `bbx remote add` commands for the other side. Raw Browser Bridge TCP is not
encrypted, so the loopback bind plus SSH tunnel is the default and recommended workflow.

Re-running `bbx proxy enable` is **idempotent**: it reuses the existing port, bind host, and
token, so already-configured clients keep working. Flags you pass explicitly override the stored
values; the secret only changes when you ask for it:

```bash
bbx proxy enable                  # safe to re-run - settings and token unchanged
bbx proxy enable --port 9444      # change the port, keep the token
bbx proxy enable --rotate-token   # generate a new secret (re-add on every client)
bbx proxy status                  # config, bind address, and daemon reachability
bbx proxy disable                 # remove the config and restart the daemon on local-only transport
```

While proxy mode is on, the extension side panel displays a "Remote proxy is on" banner with
the bind endpoint, so exposure is never silent.

## 2. Open an SSH tunnel from the dev machine

Keep this command running on the machine where your agent runs:

```bash
ssh -N -L 9223:127.0.0.1:9223 user@browser-machine
```

This makes the browser machine's loopback-only proxy available at `127.0.0.1:9223` on the dev
machine without exposing Browser Bridge's unencrypted TCP transport to the network.

> Proxy mode does not change what the extension can do or which permissions it needs. It only
> lets authenticated agents reach the same daemon over TCP instead of the local socket.

## 3. Register the remote on the dev machine

```bash
umask 077
mkdir -p ~/.config
printf '%s\n' '<token-from-step-1>' > ~/.config/bbx-vm.token
bbx remote add vm-private 127.0.0.1:9223 --token-file ~/.config/bbx-vm.token
bbx remote test vm-private        # health.ping through the proxy
bbx remote list                   # configured remotes (tokens are never printed)
bbx remote remove vm-private      # forget it
```

Port `9223` is assumed when omitted. Credentials are stored with `0600` permissions in
`remotes.json` under the Browser Bridge data directory.

Direct LAN binding remains available for controlled private networks, but it requires an explicit
acknowledgement because traffic is unencrypted:

```bash
# Browser machine: exposes raw token-authenticated TCP to the LAN.
bbx proxy enable --bind-host 0.0.0.0 --unsafe-plaintext

# Dev machine: direct connection, without an SSH tunnel.
bbx remote add vm-private 192.168.56.20:9223 --token-file ~/.config/bbx-vm.token
```

## 4. Use it from the CLI

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

## 5. Use it from MCP

MCP tools take an optional `destinationId` parameter:

- `browser_status` lists all destinations (`local` plus each configured remote) with
  reachability, so agents can discover what is available.
- Pass `destinationId: "vm-private"` on `browser_tabs`, `browser_dom`, `browser_page`,
  `browser_input`, `browser_call`, and the rest to route a single call to the remote browser.
- `browser_batch` accepts `destinationId` per call, so one batch can mix local and remote reads.
- `browser_status` and `browser_tabs` list aggregate configured destinations when no destination
  is specified. Other tools stay local unless `destinationId` is explicit.

## Troubleshooting

| Symptom | Check |
|---|---|
| `bbx remote test` not reachable | The SSH tunnel is running; `bbx proxy status` on the browser machine says the daemon is reachable |
| `Bridge daemon authentication failed` | Token mismatch - re-run `bbx proxy enable` and re-add the remote with the printed token |
| Reachable but `extension not connected` | Chrome with the Browser Bridge extension isn't running on the remote machine, or `bbx install` wasn't run there |
| Access denied on remote calls | Window access must be enabled in the remote browser's extension popup/side panel |

Related: [Quickstart](./quickstart.md) · [CLI guide](./cli-guide.md) · [Troubleshooting](./troubleshooting.md)

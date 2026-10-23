# v1 to v2 rollout

The `v1` branch starts from `main` at `6ddbee0`. Release 1.15.x remains a Node.js
runtime. It prepares existing npm installations for the Go-based v2 release.

## Release sequence

1. Publish the 1.15.x npm package, then the matching extension. Users need both
   components updated. Older runtimes with automatic updates disabled cannot be
   upgraded by extension JavaScript alone. Give those users this one-time step:

   ```bash
   npm install -g @browserbridge/bbx@1.15
   bbx restart
   ```

2. Allow one to two weeks for adoption. Keep publishing Node-only fixes on
   `v1`. A 1.15 extension must not select a v2 npm release, even though their
   wire protocol is shared. This guard applies to the 1.15 updater; older
   opted-in runtimes still follow their own selection rules. Elapsed time is
   not proof that every local runtime has updated.
3. Verify and publish the v2 native assets, then the v2 npm package, then update
   the extension. Do not rely only on elapsed time: test real 1.15 installations
   on each supported platform before the extension rollout.
4. On the next local CLI invocation or MCP process startup, 1.15 sees the newer
   extension, installs a compatible stable npm release, and launches that
   package's current entrypoint. No Go executable is bundled in 1.15.

## Compatibility and user state

- Node 1.15 emits wire protocol `2.0`. Its method definitions, request types,
  normalization, limits, and operation timeout policies follow the v2 contract.
  It also accepts v1 peers while older clients and extensions are still running.
- Missing update policy means `compatible`. Explicit `autoUpdate: "off"` and
  `BBX_AUTO_UPDATE=off` remain authoritative. Installation still requires a real
  global npm package; source checkouts, npm links, project dependencies, and
  remote destinations do not trigger local replacement.
- The updater takes a global-package lock, excludes prereleases, and never
  downgrades. A failed registry lookup leaves the Node runtime usable with the
  v2 extension. npm install failures retain the normal manual recovery path;
  this is not a transactional package rollback.
- The CLI preflight runs before reading piped input or dispatching actions.
  MCP preflight runs before reading `initialize`. Existing MCP sessions do not
  upgrade in the middle of a tool call; they continue on Node until restarted.
- 1.15 saves enabled-window grants to the same local backup used by v2. Updates
  restore only an existing window; disabling access, closing that window, or
  starting a new browser session removes the backup. An older extension cannot
  supply a grant backup it never wrote.
- npm and native registration retain the bridge home, credentials, profile
  labels, and existing agent configuration. Runtime upgrade does not install new
  integrations or overwrite user-edited skills.

## v2 release requirements

The preparation branch alone does not guarantee the final rollout. Before v2
ships:

- Replace its package-major-only mismatch banner with protocol-aware comparison
  so a connected Node 1.15 runtime is not falsely reported as incompatible.
- Keep legacy absolute JavaScript entrypoints as small compatibility launchers,
  or migrate recognized existing local MCP configurations before removing them.
  Standard `bbx mcp serve` configurations work through npm's replaced shims.
- Verify existing browser registrations and custom extension origins, including
  Edge and Brave, against the v2 postinstall path.
- Test Node 1.15 client to Go v2 daemon, Go v2 client to Node 1.15 daemon,
  old v1 clients to Node 1.15, and the two mixed extension/runtime combinations.
- Exercise npm failure, explicit opt-out, concurrent updates, piped CLI input,
  MCP initialization during handoff, active MCP sessions, browser restart,
  and a user skipping 1.15 entirely.

No automatic browser action retry is part of migration. Users who skip 1.15 or
explicitly disable updates retain a manual update path.

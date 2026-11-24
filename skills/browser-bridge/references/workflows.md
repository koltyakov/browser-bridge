# Workflows

Worked sequences. Prefer one `input.perform` call once the steps and expected outcome are known.

### Debug a CSS layout issue

```bash
bbx status                                         # confirm connection
bbx dom-query '.broken-component'                  # inspect the DOM subtree
bbx styles ref_abc123 display,flex-direction,gap    # check computed styles
bbx patch-style ref_abc123 display=flex gap=8px     # prototype a fix
bbx box ref_abc123                                  # verify dimensions
bbx rollback patch_1                                # clean up
# → edit source file with the confirmed fix
```

### Find and fix broken text content

```bash
bbx find 'Error: something went wrong'             # locate the error text
bbx describe ref_xyz789                             # understand the element
bbx html ref_xyz789 500                             # check surrounding markup
bbx patch-text ref_xyz789 'Updated message'         # test replacement
bbx text ref_xyz789                                 # verify the change
bbx rollback patch_2                                # clean up
```

### Verify an API call

```bash
bbx call page.get_console '{"clear":true}'          # install + clear console capture
bbx call page.get_network '{"clear":true}'          # install + clear network capture
# reproduce the API action here
bbx console error                                   # read newly captured runtime errors
bbx network 20                                      # read newly captured requests
bbx eval 'document.querySelector("#app").__vue__.$store.state.user'  # read framework state
bbx page-text 2000                                  # extract page content
```

## Dev-Server Workflow (HMR-aware)

When the user has a localhost dev server with watch/HMR:

1. **Inspect current state** - `page.get_state` + quick `dom.query` on the relevant area.
2. **Read framework state** - `page.evaluate` to check router, component props, store values.
3. **Identify the problem** - use `styles.get_computed`, `dom.get_html`, or `page.get_console` for errors.
4. **Prototype with patches** - `patch.apply_styles` / `patch.apply_dom` to verify the fix visually.
5. **Edit source files** - modify the actual code in the agent's workspace.
6. **Wait for HMR** - use `dom.wait_for` for expected new text, a selector matching the changed attribute, or a detach/attach remount. Do not wait for `attached` on an unchanged selector that already exists.
7. **Verify the change** - re-inspect the same area; compare with patch expectations.
8. **Check for regressions** - `page.get_console` for new errors; scroll and inspect adjacent areas.
9. **Rollback patches** - `patch.rollback` all temporary patches.

## Investigate-a-Bug Workflow

```
page.get_state → page.get_console(clear: true) + page.get_network(clear: true)
  → reproduce the bug → page.get_console + page.get_network
  → dom.find_by_text('<error text>') or dom.query('<selector>')
  → styles.get_computed (check layout/visibility)
  → page.evaluate('document.querySelector(...).dataset') (read data attrs)
  → page.evaluate('window.__APP_STATE__') (read framework state)
  → patch.apply_styles (test fix) → verify → edit source → wait for HMR → verify
```

## User-Flow Testing Workflow

Once the next actions and expected outcome are known, run them in one call rather than pausing for model reasoning between each step:

```bash
bbx call input.perform '{
  "returnLastResult": true,
  "steps": [
    {"method":"input.fill","params":{"target":{"label":"Email"},"value":"user@example.com"}},
    {"method":"input.click","params":{"target":{"role":"button","name":"Save"}}},
    {"method":"dom.wait_for","params":{"selector":"[role=status]","text":"Saved","state":"visible"}},
    {"method":"dom.get_text","params":{"target":{"selector":"[role=status]"},"textBudget":200}}
  ]
}'
```

The final read is returned in `lastResult.result`. Only the final step's result is retained, at most 16384 UTF-8 JSON bytes. If `lastResult.truncated` is true, narrow the read without replaying the actions. For a final action instead of a read, request `observe: true` on that step to receive its effects. Sequence steps do not observe by default. Completed input dispatch alone does not prove application success.

When the result requires a new decision, return to the agent before continuing. Individual calls remain appropriate for exploratory flows:

```
input.click({target: {role: 'button', name: 'Login'}})
  → page.wait_for_load_state({url: '/dashboard', urlMatch: 'contains', waitForLoad: false})
  → dom.query('.dashboard', {maxNodes: 15}) when effects do not answer the objective
  → page.get_console only when checking runtime errors
```

# Protocol Reference

## All Methods (36)

| # | Method | Session? | Notes |
|---|--------|----------|-------|
| 1 | `tabs.list` | No | Discover available tabs |
| 2 | `session.request_access` | No | Create/reuse session (tab must be UI-enabled) |
| 3 | `session.get_status` | Yes | Confirm session validity |
| 4 | `session.revoke` | Yes | End session |
| 5 | `skill.get_runtime_context` | No | Live budget presets + method groups |
| 6 | `health.ping` | No | Bridge connectivity check |
| 7 | `log.tail` | No | Recent bridge logs |
| 8 | `page.get_state` | Yes | URL, readiness, focus, scroll, viewport |
| 9 | `navigation.navigate` | Yes | Go to URL; `waitForLoad` default true |
| 10 | `navigation.reload` | Yes | Reload; `waitForLoad` default true |
| 11 | `navigation.go_back` | Yes | History back |
| 12 | `navigation.go_forward` | Yes | History forward |
| 13 | `dom.query` | Yes | Query subtree with budget constraints |
| 14 | `dom.describe` | Yes | Single element details via `elementRef` |
| 15 | `dom.get_text` | Yes | Text content with `textBudget` |
| 16 | `dom.get_attributes` | Yes | Targeted attribute read |
| 17 | `layout.get_box_model` | Yes | Element geometry (no budget needed) |
| 18 | `layout.hit_test` | Yes | Element at viewport point |
| 19 | `styles.get_computed` | Yes | Computed CSS; always set `properties` |
| 20 | `styles.get_matched_rules` | Yes | Matching CSS rules |
| 21 | `viewport.scroll` | Yes | Window or element scroll |
| 22 | `input.click` | Yes | DOM-level click |
| 23 | `input.focus` | Yes | Focus element |
| 24 | `input.type` | Yes | Type text into input/contenteditable |
| 25 | `input.press_key` | Yes | Single key event |
| 26 | `input.set_checked` | Yes | Checkbox/radio toggle |
| 27 | `input.select_option` | Yes | Native select by value/label/index |
| 28 | `screenshot.capture_element` | Yes | Cropped element screenshot |
| 29 | `screenshot.capture_region` | Yes | Cropped viewport region |
| 30 | `patch.apply_styles` | Yes | Reversible CSS patch |
| 31 | `patch.apply_dom` | Yes | Reversible DOM mutation |
| 32 | `patch.list` | Yes | Active patches |
| 33 | `patch.rollback` | Yes | Revert one patch |
| 34 | `patch.commit_session_baseline` | Yes | Accept current state as baseline |
| 35 | `cdp.get_document` | Yes | DevTools document tree |
| 36 | `cdp.get_dom_snapshot` | Yes | DevTools DOM snapshot |

Also: `cdp.get_box_model`, `cdp.get_computed_styles_for_node` (DevTools-backed reads).

## CLI

```bash
npx bb status | logs | tabs | skill         # no session needed
npx bb request-access [tabId] [origin]       # create session
npx bb call <method> '{"key":"val"}'         # generic RPC (auto-session)
npx bb call <sessionId> <method> '{...}'     # explicit session
npx bb batch '[{"method":"...","params":{}}]'  # parallel calls
```

**Convenience shortcuts:** `dom-query`, `describe`, `text`, `styles`, `box`, `click`, `focus`, `type`, `press-key`, `patch-style`, `patch-text`, `patches`, `rollback`, `screenshot`, `session`, `revoke`

## Request Envelope

```json
{"id":"req_1","session_id":"sess_abc","method":"dom.query","params":{},"meta":{"protocol_version":"1.0","token_budget":1200}}
```

## Error Codes

| Code | Action |
|------|--------|
| `ACCESS_DENIED` | User must enable tab in extension UI |
| `SESSION_EXPIRED` | Re-run `request-access` |
| `ORIGIN_MISMATCH` | Session bound to different origin |
| `CAPABILITY_MISSING` | Request capability not in session |
| `ELEMENT_STALE` | Re-query DOM for fresh `elementRef` |
| `NATIVE_HOST_UNAVAILABLE` | Check daemon: `npx bb status` |
| `APPROVAL_PENDING` | Wait + retry (see access retry flow) |

Timeout on content-script request → use narrower `dom.query` or CDP fallback.
Timeout on navigation → increase `timeoutMs`, set `waitForLoad:false`, or check `page.get_state`.

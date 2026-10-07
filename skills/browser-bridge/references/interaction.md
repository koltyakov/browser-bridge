# Interaction Patterns

## Input Methods

| Method                   | CLI Shortcut                          | Purpose                                                     |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------- |
| `input.click`            | `click <ref> [button]`                | Auto-waiting, actionability-aware click with observed `effects`; locator targets; optional CDP; `holdMs` |
| `input.focus`            | `focus <ref>`                         | Focus an element                                            |
| `input.type`             | `type <ref> <text>`                   | DOM key sequence; optional CDP native text insertion        |
| `input.fill`             | `fill <ref> <value>`                  | DOM fill strategy; optional CDP clear and text insertion    |
| `input.press_key`        | `press-key <key> [ref]`               | Send keyboard key (Enter, Backspace, etc.); optional CDP; `holdMs` |
| `cdp.dispatch_key_event` | `cdp-press-key --tab <id> <key>`      | CDP keyDown/keyUp without focusing the target tab           |
| `input.set_checked`      | `call input.set_checked '{...}'`      | Toggle checkbox/radio                                       |
| `input.select_option`    | `call input.select_option '{...}'`    | Select native `<select>` by value/label/index               |
| `input.hover`            | `hover <ref>`                         | DOM hover events or optional CDP pointer move               |
| `input.drag`             | `call input.drag '{...}'`             | HTML5 drag for draggable sources, pointer drag otherwise; optional CDP |
| `input.touch`            | `call input.touch '{...}'`            | One or more simultaneous touch points: chords, taps, swipes, pinches |
| `input.perform`          | `call input.perform '{...}'`          | Ordered, timed sequence of input steps run inside the browser |
| `input.scroll_into_view` | `call input.scroll_into_view '{...}'` | Ensure a target is visible before inspect/capture           |

## Navigation

```bash
bbx navigate 'https://localhost:3000/dashboard'
bbx call navigation.navigate '{"url":"https://example.com","waitForLoad":true}'
bbx call navigation.reload '{"waitForLoad":true}'
bbx call navigation.go_back
bbx call navigation.go_forward
```

- `waitForLoad` defaults `true`; set `false` for long-lived pages.
- If navigation times out, retry with larger `timeoutMs` or check with `page.get_state`.

For a navigation or SPA route caused by input, use event-aware URL conditions instead of polling:

```bash
bbx call page.wait_for_load_state '{"url":"/dashboard","urlMatch":"contains","waitForLoad":false,"timeoutMs":10000}'
```

The current URL is checked first. The wait then observes full navigation, tab URL/status updates, `pushState`, `replaceState`, `popstate`, and hash changes. It returns the final URL, elapsed time, and observed navigation kind. `waitForLoad: true` means Chrome tab status `complete`, not `networkidle`. Regex mode is deliberately restricted to a bounded linear subset without grouping, alternation, quantifiers, or backreferences.

## Viewport

```bash
bbx call viewport.scroll '{"top":640,"behavior":"smooth"}'
bbx call viewport.scroll '{"target":{"elementRef":"el_123"},"top":200}'
```

Scrolls the window or a specific scrollable element.

### Resize Viewport

Set device viewport dimensions (useful for responsive testing):

```bash
bbx resize 375 812                           # iPhone-size
bbx resize 1024 768                          # tablet
bbx call viewport.resize '{"reset":true}'    # restore original
```

Uses CDP device emulation - the page re-renders at the new size immediately.

## Tab Management

**IMPORTANT: Prefer existing tabs.** Never create new tabs unless:

- The user explicitly requests opening a new page
- The task requires a clean/fresh page state (e.g., testing initial load)
- You need to compare multiple pages simultaneously

Always start with `tabs.list` to find an appropriate existing tab before considering `tabs.create`.

```bash
bbx tabs                                 # list available tabs (start here)
bbx tab-create https://example.com       # open new tab (avoid unless necessary)
bbx tab-create                           # open blank tab (avoid unless necessary)
bbx tab-close 12345                      # close tab by ID
bbx tab-activate 12345                   # bring a tab to the foreground
bbx call tabs.create '{"url":"https://example.com","active":false}'
```

Typical workflow - compare two pages (only when comparison is required):

1. `tabs.list` to see current tabs
2. `tabs.create` with second URL
3. Inspect both tabs (`--tab <id>` or MCP `tabId` only when you need the non-active tab)
4. `tabs.close` when done

## Accessibility Outline

For a page overview you can act on, use the DOM outline. It needs no debugger, covers shadow DOM and iframes, and every line carries a ref that input methods accept directly:

```bash
bbx call dom.get_accessibility_tree '{"source":"dom","interactiveOnly":true}'
# - textbox "Email address" [el_k7q2_3] required
# - button "Place order" [el_k7q2_4]
# - iframe [frame 7]
#   - button "Pay now" [el_m2xa_1]
bbx call input.click '{"target":{"elementRef":"el_m2xa_1"}}'
```

Usually you can skip the overview and act with a locator in one call: `{"target":{"role":"button","name":"Pay now"}}`.

The default `source: "cdp"` returns Chrome's AX tree through the debugger. Use it for accessibility audits (`compact`, `interactiveOnly`, `maxDepth`, `format: "outline"`); its nodes have no refs.

## Multi-Tab Workflows

Access is window-scoped. Your first call binds your session to the active tab in the enabled window, which becomes your working tab, and later calls stay there even when the user switches tabs. Responses include `meta.tab_id`; when the user is looking at a different tab, the summary names both. `tabs.list` marks your tab with `working: true`. Passing `tabId`, `tabs.create`, or `tabs.activate` moves your working tab. A closed working tab fails with `TAB_MISMATCH` (`working_tab_closed`) rather than switching to whatever tab is active.

```bash
# Default routing follows the active tab in the enabled window:
bbx tabs
bbx page-text

# Explicit non-active tab targeting when needed:
bbx call --tab 100 page.get_text
bbx call --tab 200 dom.query '{"selector":"main"}'
```

Open a new tab programmatically:

```bash
bbx tab-create https://example.com   # creates a new tab in the enabled window
bbx call --tab <new-tabId> page.get_state
```

**Note:** `tabs.list`, `tabs.create`, and `tabs.close` do not require a routed tab.

## Scroll

Scroll the viewport or a scrollable element:

```bash
bbx scroll 640              # scroll down 640px
bbx scroll 0 200            # scroll right 200px
bbx scroll 0                # scroll to top (top=0)
bbx call viewport.scroll '{"top":640,"behavior":"smooth"}'
bbx call viewport.scroll '{"target":{"elementRef":"el_123"},"top":200}'
```

Scrolls the window by default. Pass `target: { elementRef }` to scroll an inner scrollable container.

### Scroll target into view

Use this when the page has nested containers or when you want the target centered before a screenshot or hover:

```bash
bbx call input.scroll_into_view '{"target":{"elementRef":"el_123"}}'
bbx call input.scroll_into_view '{"target":{"selector":"[data-testid=\"submit-button\"]"}}'
```

## Network Monitoring

```bash
bbx call page.get_console '{"clear":true}' # install capture and clear old console entries
bbx call page.get_network '{"clear":true}' # install capture and clear old network entries
# reproduce the interaction here
bbx network 50                           # newly captured requests
bbx console error                        # newly captured errors
```

Default fetch/XHR entries are retained in capture order and contain `method`, `url`, `status`, `duration`, `type`, `ts`, and `size`.

Typical workflow - debug API calls:

1. Prime and clear `page.get_console` and `page.get_network`
2. Reproduce the interaction
3. Read and filter `page.get_network` by URL pattern or status code
4. Cross-reference with `page.get_console` for errors
5. Use `page.evaluate` only if lighter evidence cannot expose the needed response state

For document, script, stylesheet, image, WebSocket, WebTransport, and other resource metadata, explicitly arm CDP before reproducing:

```bash
bbx call page.get_network '{"source":"cdp","capture":"start"}'
# reproduce activity
bbx call page.get_network '{"source":"cdp","capture":"read","limit":50}'
bbx call page.get_network '{"source":"cdp","capture":"stop"}'
```

This holds debugger ownership and is more expensive than default instrumentation. A plain read cannot recover events from before `start`. CDP results report armed/ownership/inflight/drop state and redact URL credentials, fragments, and query values; bodies, cookies, authorization values, and complete headers are excluded.

## Network Interception

Block, stub, or modify matching requests via CDP (debugger-backed). Patterns are globs: `*` matches any characters, `?` matches one character.

```bash
bbx intercept add 'https://api.example.com/users*' --respond '{"users":[]}' --status 200
bbx intercept add '*analytics*' --block      # fail matching requests
bbx intercept list                           # active rules
bbx intercept remove intercept_1
bbx intercept clear                          # remove all rules, detach debugger
```

Caveats:

- Rules are **in-memory and per-tab**. They drop silently if the debugger detaches (user dismisses the infobar, tab closes, extension service worker restarts). Verify with `bbx intercept list` before relying on them.
- Sessions auto-expire after 10 minutes as a safety net.
- Always `bbx intercept clear` when finished so the page returns to normal traffic.

## Form Controls

**Checkbox/radio:**

```bash
bbx call input.set_checked '{"target":{"elementRef":"el_123"},"checked":true}'
```

**Select dropdown:**

```bash
bbx call input.select_option '{"target":{"elementRef":"el_456"},"values":["us"]}'
```

Select by value, label, or index. Multiple values for multi-select.

**Text fields - `fill` vs `type`:**

```bash
bbx fill el_123 hello@example.com        # set value instantly (preferred for forms)
bbx type el_123 hello                    # simulate per-character keystrokes
```

Prefer `fill` for setting form values: it uses the native prototype setter plus `input`/`change`/`blur` events, which React, Vue, and Angular pick up reliably. `mode` defaults to `auto` (setter first, keystroke fallback if the value did not stick); pass `"mode":"keystrokes"` via `bbx call input.fill` for components that only react to per-key events. Use `type` when page logic depends on individual key events (autocomplete, masked inputs).

`mode` is not `executionMode`. The latter accepts only `dom` or `cdp`, defaults to `dom` for compatibility, and selects the dispatch path. CDP execution is available for click, hover, drag, type, fill, press_key, and touch; unsupported combinations fail with `INPUT_UNSUPPORTED` instead of silently changing paths.

## DOM vs CDP Input

DOM mode dispatches the same event sequence a real device produces, so most pages cannot tell the difference:

- **Clicks**: `pointerover`/`pointerenter`/`mouseover`/`mouseenter` (only when the virtual pointer moves onto a new element), `pointermove`/`mousemove`, `pointerdown`/`mousedown`, focus, optional hold, `pointerup`/`mouseup`, then `click` (`contextmenu` for right, `auxclick` for middle) carrying coordinates, modifiers, `detail`, and `pointerType`. A canceled `pointerdown` suppresses the mouse events; a canceled `mousedown` keeps focus where it was. Leaving an element fires `pointerout`/`mouseout`/`leave` on it.
- **Keys**: `keydown` with `key`, `code`, and `keyCode`, `keypress` for character keys, the editing action, then `keyup`. A canceled `keydown` suppresses the character, as in browsers.

DOM events are still untrusted (`isTrusted: false`) and do not count as a user gesture, so Chrome may refuse what a page gates on one: starting audio or media (unless the site already has autoplay engagement), popups, clipboard writes, and fullscreen. When a page needs a real gesture, use `executionMode: "cdp"`, which dispatches trusted input through Chrome. If sound or video stays silent after a DOM click, retry the first interaction with CDP.

## Press and Hold

`holdMs` (0-10000) keeps a mouse button or key pressed between down and up:

```bash
bbx call input.click '{"target":{"selector":"[data-midi=\"60\"]"},"holdMs":400}'
bbx call input.press_key '{"key":"q","holdMs":400,"executionMode":"cdp"}'
```

Use it for long-press menus, sustained notes, and buttons that act while pressed.

## Timed Sequences

Every tool call costs an agent round-trip, so steps sent one call at a time arrive seconds apart, and steps sent as parallel tool calls all land at once. When timing matters (music, games, animations, gestures, quick reactions), send the whole schedule as one `input.perform`:

```bash
bbx call input.perform '{
  "executionMode": "cdp",
  "steps": [
    {"method":"input.click","params":{"target":{"selector":"[data-midi=\"60\"]"},"holdMs":350},"atMs":0},
    {"method":"input.click","params":{"target":{"selector":"[data-midi=\"62\"]"},"holdMs":350},"atMs":400},
    {"method":"input.touch","params":{"points":[{"target":{"selector":"[data-midi=\"60\"]"}},{"target":{"selector":"[data-midi=\"64\"]"}},{"target":{"selector":"[data-midi=\"67\"]"}}],"holdMs":700},"atMs":800}
  ]
}'
```

- Each step is `{ method, params, atMs | delayMs }`; `params` are exactly what the method takes on its own.
- Allowed step methods: `input.click`, `input.focus`, `input.type`, `input.fill`, `input.press_key`, `input.set_checked`, `input.select_option`, `input.hover`, `input.drag`, `input.touch`, `input.scroll_into_view`, `viewport.scroll`, `dom.wait_for`, `page.wait_for_load_state`.
- `atMs` is the earliest start measured from the sequence start, so delays never accumulate; `delayMs` waits after the previous step finished. Steps always run in order, so a step whose `atMs` has already passed starts immediately.
- A top-level `executionMode` applies to every step that supports it unless the step sets its own.
- Add `dom.wait_for` steps to react to the page without a round-trip, e.g. click, wait for `.menu`, click the item. A wait that times out counts as a failed step.
- The sequence stops at the first failure with that step's error code and `details.failedStep`, `completed`, and `startedAtMs`. Set `continueOnError: true` to run every step and collect `failures`.
- `timeoutMs` (default 30000, max 120000) bounds the whole sequence, and waiting steps are capped to the remaining budget. At most 200 steps.
- The result reports `startedAtMs` (actual start of every step), so you can verify the rhythm without a screenshot. Then verify application state as usual.

## Touch and Multi-Finger Input

A mouse is one pointer, so it cannot press two things at once. `input.touch` puts every point down together, holds them for `holdMs` (default 50), and lifts them together:

```bash
# Three-finger chord
bbx call input.touch '{"points":[{"target":{"selector":"#c4"}},{"target":{"selector":"#e4"}},{"target":{"selector":"#g4"}}],"holdMs":600,"executionMode":"cdp"}'
# Swipe, and pinch-out with viewport coordinates
bbx call input.touch '{"points":[{"x":300,"y":400,"to":{"x":60,"y":400}}],"holdMs":250}'
bbx call input.touch '{"points":[{"x":200,"y":300,"to":{"x":120,"y":300}},{"x":240,"y":300,"to":{"x":320,"y":300}}],"holdMs":300,"moveSteps":12}'
```

- Each point is either `target` (`elementRef`/`selector`, actionability-checked at its center) or viewport `x`/`y`, plus an optional `to` end position. Up to 10 points.
- Points with `to` move in `moveSteps` (default 10) interpolated steps spread across `holdMs`.
- DOM mode fires per-finger `pointerdown`/`pointermove`/`pointerup` (`pointerType: "touch"`, distinct `pointerId`, first finger primary) and `touchstart`/`touchmove`/`touchend` with accurate `touches`. A single-finger tap without movement also produces the compatibility `mousedown`/`mouseup`/`click`.
- CDP mode sends trusted `Input.dispatchTouchEvent` events; fingers are always lifted, even after an error. Pages that only enable touch handlers after feature-detecting a touch screen may still ignore desktop touch input.
- Result: `pointCount`, per-point `elementRef` and coordinates, and in DOM mode `canceled` (the page called `preventDefault`) and `clicked`.

## Actionability And Stale Refs

Input selectors preserve the first match when it is actionable. Otherwise Browser Bridge evaluates at most 25 candidates and proceeds only when one is uniquely preferable. It scrolls the selected target as needed, then rechecks rendered bounds, hidden/disabled/inert state, and pointer hit testing. Expect structured `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_ACTIONABLE`, `ELEMENT_OBSCURED`, or `ELEMENT_AMBIGUOUS` errors rather than best-effort retargeting.

Successful targeted click, focus, type, fill, press-key, checked-state, option-selection, hover, and drag results report `resolution` and `execution` metadata. `cdp_press_key` and `scroll_into_view` use separate contracts. Explicit refs preserve exact identity. Stale refs fail by default; `recoverStale: true` allows a single same-document, unchanged-URL recovery only from a strong unique semantic descriptor, and reports old/new refs and matched fields. The recovery scan evaluates at most 100 same-tag candidates and returns `ELEMENT_AMBIGUOUS` with `reason: "scan_incomplete"` whenever additional candidates make uniqueness unprovable. Prefer a fresh query unless this strict recovery contract clearly applies.

After any DOM or CDP input, verify the intended application outcome with a targeted wait or structured read. Event dispatch alone is not proof that application state changed.

## JavaScript Dialogs

Dialogs are never accepted or dismissed automatically:

```bash
bbx call page.handle_dialog '{"action":"inspect"}'
bbx call page.handle_dialog '{"action":"accept","expectedDialogId":"00000000-0000-4000-8000-000000000000:1"}' # replace with inspected dialogId
bbx call page.handle_dialog '{"action":"dismiss","expectedDialogId":"00000000-0000-4000-8000-000000000000:1"}' # replace with inspected dialogId
```

`expectedDialogId` is checked immediately before the CDP command, but Chrome cannot atomically bind that command to the observation. A successful mutation reports `commandDispatched: true` and `atomicDialogBinding: false`. On `DIALOG_ACTION_CONFLICT`, inspect again and do not automatically repeat the mutation. Dialog text is returned only to the caller and is excluded from persisted action logs.

## Hover

Dispatch mouse events to trigger CSS `:hover` rules, tooltip display, dropdown menus, etc.

```bash
bbx hover el_abc123
bbx call input.hover '{"target":{"elementRef":"el_abc123"}}'
```

**Hold hover for inspection:** set `duration` (ms) to wait after hovering before the call returns. The pointer stays over the element until a later input moves it elsewhere, which then fires `mouseout`/`mouseleave`:

```bash
bbx call input.hover '{"target":{"elementRef":"el_abc123"},"duration":2000}'
```

Typical workflow - inspect a tooltip:

1. `dom.query` to find the trigger element → `elementRef`
2. `input.hover` with `duration: 2000`
3. While hover holds, `dom.query` for tooltip content (e.g. `[role="tooltip"]`)
4. `styles.get_computed` on tooltip to verify positioning

## Drag and Drop

Full drag-and-drop requires source and destination element refs:

```bash
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"}}'
```

With pixel offsets for precise positioning:

```bash
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"offsetX":5,"offsetY":5}'
```

DOM mode picks the sequence a browser would use:

- **Draggable sources** (`draggable="true"`, links, images): `pointerdown → mousedown → dragstart → pointercancel → drag → dragenter → dragover → drop → dragend`. `drop` only fires when the destination cancels `dragover`, as real drop zones must; otherwise it gets `dragleave`.
- **Other sources** (sortable lists, sliders, canvases, and other pointer-driven UIs): `pointerdown/mousedown`, ten interpolated `pointermove/mousemove` steps with the button held across whatever elements lie under the path (with over/out transitions), then `pointerup/mouseup` at the destination.

The result's `strategy` reports `html5` or `pointer`. CDP mode drives a real pointer drag either way.

Typical workflow - reorder a list:

1. `dom.query` to find draggable items → get source and destination `elementRef` values
2. `input.drag` from source to destination
3. `dom.wait_for` to confirm the DOM updated
4. `dom.query` to verify new order

## Finding Elements

### By text content

Find elements matching visible text. Faster than `dom.query` when you know the label:

```bash
bbx find 'Submit Order'
bbx call dom.find_by_text '{"text":"Add to Cart","selector":"button","exact":false}'
```

- `selector`: optional CSS selector to narrow search (e.g. `"button"`, `".sidebar"`)
- `exact`: `true` for exact match, `false` (default) for substring/case-insensitive

### By ARIA role

Find elements by explicit `role` attribute or implicit HTML role (e.g. `<nav>` → `navigation`):

```bash
bbx find-role button 'Save'
bbx call dom.find_by_role '{"role":"navigation"}'
bbx call dom.find_by_role '{"role":"heading","name":"Dashboard"}'
```

## Waiting

### Wait for DOM condition

```bash
bbx wait '.success-message' 10000
bbx call dom.wait_for '{"selector":".modal","state":"visible","timeoutMs":10000}'
bbx call dom.wait_for '{"selector":".spinner","state":"detached","timeoutMs":5000}'
```

- `state`: `attached` (exists in DOM), `detached` (removed), `visible` (non-zero size), `hidden`
- Uses MutationObserver + 250 ms polling fallback
- Returns `{found, elementRef, duration}` - NOT an error on timeout

### Wait for page load

```bash
bbx call page.wait_for_load_state '{"timeoutMs":10000}'
```

Use after clicking navigation links.

## Raw `bbx call` for Interaction Methods

Targeted DOM input methods require the target wrapped in a `target` object; `input.press_key` may omit it to use the active element. Do not pass `ref` or `elementRef` at the top level. `cdp.dispatch_key_event` targets the tab, while `input.scroll_into_view` accepts `target` but does not return actionability/execution metadata:

```bash
# CORRECT
bbx call input.click '{"target":{"elementRef":"el_xxx"}}'
bbx call input.click '{"target":{"elementRef":"el_xxx"},"button":"right"}'
bbx call input.type  '{"target":{"elementRef":"el_xxx"},"text":"hello"}'
bbx call input.focus '{"target":{"selector":"#search-input"}}'

# WRONG -- "Target not found"
bbx call input.click '{"ref":"el_xxx"}'
bbx call input.click '{"elementRef":"el_xxx"}'
```

The CLI shortcuts (`bbx click el_xxx`) handle this wrapping automatically, but `bbx call` passes params as-is.

## Interaction Flow

1. **Find target**: `dom.find_by_text`, `dom.find_by_role`, or `dom.query` → get `elementRef`
2. **Focus** if needed: `input.focus` (for keyboard input)
3. **Act**: `click`, `type`, `press_key`, `hover`, `drag`, `scroll_into_view`, etc.
4. **Inspect metadata**: confirm resolution strategy, hit test, stale recovery, and actual execution path
5. **Wait**: use `dom.wait_for` or an event-aware URL wait if the action triggers async updates
6. **Verify**: `dom.describe`, `styles.get_computed`, `page.get_state`, or `page.get_console`; never infer app success from dispatch alone

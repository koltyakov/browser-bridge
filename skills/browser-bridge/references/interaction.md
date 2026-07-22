# Interaction Patterns

## Input Methods

| Method                   | CLI Shortcut                          | Purpose                                                     |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------- |
| `input.click`            | `click <ref> [button]`                | Actionability-aware DOM click; optional CDP native click    |
| `input.focus`            | `focus <ref>`                         | Focus an element                                            |
| `input.type`             | `type <ref> <text>`                   | DOM key sequence; optional CDP native text insertion        |
| `input.fill`             | `fill <ref> <value>`                  | DOM fill strategy; optional CDP clear and text insertion    |
| `input.press_key`        | `press-key <key> [ref]`               | Send keyboard key (Enter, Backspace, etc.)                  |
| `cdp.dispatch_key_event` | `cdp-press-key --tab <id> <key>`      | CDP keyDown/keyUp without focusing the target tab           |
| `input.set_checked`      | `call input.set_checked '{...}'`      | Toggle checkbox/radio                                       |
| `input.select_option`    | `call input.select_option '{...}'`    | Select native `<select>` by value/label/index               |
| `input.hover`            | `hover <ref>`                         | DOM hover events or optional CDP pointer move               |
| `input.drag`             | `call input.drag '{...}'`             | DOM drag events or optional CDP pointer drag                |
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

## Accessibility Tree

Retrieve a depth-limited accessibility tree for the page. Useful for understanding semantic structure, finding interactive elements, and accessibility audits.

```bash
bbx a11y-tree                   # default limits
bbx a11y-tree 50 3              # max 50 nodes, depth 3
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5}'
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":6,"compact":true}'
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":6,"interactiveOnly":true}'
```

Each node includes semantic state plus `interactive`, `semanticInteractive`, `focusable`, `focusableAndEnabled`, `ignored`, and `childIds`. `interactive` is not a current actionability guarantee. Compact and interactive-only filters run before `maxNodes`; results report partial depth topology, missing children, and continuation guidance. AX nodes do not become page refs, so use `dom.find_by_role` before input.

Typical workflow - find interactive controls:

1. `dom.get_accessibility_tree` with small `maxNodes`
2. Scan for nodes with `interactive: true`
3. Use role/name to identify the right control
4. `dom.find_by_role` to get an `elementRef` for interaction

## Multi-Tab Workflows

Access is window-scoped. Once the user enables Browser Bridge for a browser window, the bridge follows the active tab in that window automatically.

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

`mode` is not `executionMode`. The latter accepts only `dom` or `cdp`, defaults to `dom` for compatibility, and selects the dispatch path. CDP execution is available only for click, hover, drag, type, and fill; unsupported combinations fail with `INPUT_UNSUPPORTED` instead of silently changing paths.

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

**Hold hover for inspection:** set `duration` (ms) to keep hover active before auto-releasing with `mouseleave`:

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

Event sequence: `mousedown → dragstart → drag → dragenter → dragover → drop → dragend → mouseup`.

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

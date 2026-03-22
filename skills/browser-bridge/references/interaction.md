# Interaction Patterns

## Input Methods

| Method | CLI Shortcut | Purpose |
|--------|-------------|---------|
| `input.click` | `click <ref> [button]` | DOM-level click |
| `input.focus` | `focus <ref>` | Focus an element |
| `input.type` | `type <ref> <text>` | Type into input/textarea/contenteditable |
| `input.press_key` | `press-key <key> [ref]` | Send keyboard key (Enter, Backspace, etc.) |
| `input.set_checked` | `call input.set_checked '{...}'` | Toggle checkbox/radio |
| `input.select_option` | `call input.select_option '{...}'` | Select native `<select>` by value/label/index |
| `input.hover` | `hover <ref>` | Trigger CSS `:hover` state (mouseenter/mouseover/mousemove) |
| `input.drag` | `call input.drag '{...}'` | Full drag-and-drop event sequence |

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

## Viewport

```bash
bbx call viewport.scroll '{"top":640,"behavior":"smooth"}'
bbx call viewport.scroll '{"elementRef":"el_123","top":200}'
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

Open and close tabs programmatically. Neither requires a session.

```bash
bbx tab-create https://example.com     # open new tab
bbx tab-create                          # open blank tab
bbx tab-close 12345                     # close tab by ID
bbx call tabs.create '{"url":"https://example.com","active":false}'
```

Typical workflow - compare two pages:
1. `tabs.list` to see current tabs
2. `tabs.create` with second URL
3. Inspect both tabs (each needs its own session)
4. `tabs.close` when done

## Accessibility Tree

Retrieve the full accessibility tree for the page. Useful for understanding semantic structure, finding interactive elements, and accessibility audits.

```bash
bbx a11y-tree                   # default limits
bbx a11y-tree 50 3              # max 50 nodes, depth 3
bbx call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5}'
```

Each node: `role`, `name`, `description`, `value`, `focused`, `required`, `checked`, `disabled`, `interactive`, `childIds`.

Typical workflow - find interactive controls:
1. `dom.get_accessibility_tree` with small `maxNodes`
2. Scan for nodes with `interactive: true`
3. Use role/name to identify the right control
4. `dom.find_by_role` to get an `elementRef` for interaction

## Multi-Tab Workflows

Each tab requires its own session. Sessions are not shared between tabs.

```bash
# Inspect two tabs side-by-side:
bbx tabs                             # find tabId values
bbx request-access 100               # create session for tab 100
bbx page-text                        # read from tab 100

bbx revoke                           # end tab 100 session
bbx request-access 200               # switch to tab 200
bbx page-text                        # read from tab 200
```

Open a new tab programmatically:
```bash
bbx tab-create https://example.com   # creates and returns new tabId
bbx request-access <new-tabId>       # start a session on the new tab
```

Close comparison tabs when done:
```bash
bbx revoke
bbx tab-close <tabId>
```

**Note:** `tabs.list`, `tabs.create`, and `tabs.close` do not require an active session.

## Scroll

Scroll the viewport or a scrollable element:

```bash
bbx scroll 640              # scroll down 640px
bbx scroll 0 200            # scroll right 200px
bbx scroll 0                # scroll to top (top=0)
bbx call viewport.scroll '{"top":640,"behavior":"smooth"}'
bbx call viewport.scroll '{"elementRef":"el_123","top":200}'
```

Scrolls the window by default. Pass an `elementRef` to scroll an inner scrollable container.



```bash
bbx network                     # recent requests
bbx network 50                  # last 50
bbx call page.get_network '{"limit":20,"clear":true}'
```

Each entry: `method`, `url`, `status`, `duration`, `initiator`.

Typical workflow - debug API calls:
1. `page.get_network` to see recent requests
2. Filter by URL pattern or status code
3. Cross-reference with `page.get_console` for errors
4. Use `page.evaluate` to replay or inspect response data

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
bbx call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"sourceOffset":{"x":10,"y":10},"destinationOffset":{"x":5,"y":5}}'
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
bbx call dom.find_by_text '{"text":"Add to Cart","scope":"button","exact":false}'
```
- `scope`: optional CSS selector to narrow search (e.g. `"button"`, `".sidebar"`)
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

## Interaction Flow

1. **Find target**: `dom.find_by_text`, `dom.find_by_role`, or `dom.query` → get `elementRef`
2. **Focus** if needed: `input.focus` (for keyboard input)
3. **Act**: `click`, `type`, `press_key`, `hover`, `drag`, etc.
4. **Wait**: `dom.wait_for` if action triggers async updates
5. **Verify**: `dom.describe`, `styles.get_computed`, or `page.get_console` for errors

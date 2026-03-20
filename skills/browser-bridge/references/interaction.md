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
npx bb navigate 'https://localhost:3000/dashboard'
npx bb call navigation.navigate '{"url":"https://example.com","waitForLoad":true}'
npx bb call navigation.reload '{"waitForLoad":true}'
npx bb call navigation.go_back
npx bb call navigation.go_forward
```

- `waitForLoad` defaults `true`; set `false` for long-lived pages.
- If navigation times out, retry with larger `timeoutMs` or check with `page.get_state`.

## Viewport

```bash
npx bb call viewport.scroll '{"top":640,"behavior":"smooth"}'
npx bb call viewport.scroll '{"elementRef":"el_123","top":200}'
```

Scrolls the window or a specific scrollable element.

### Resize Viewport

Set device viewport dimensions (useful for responsive testing):
```bash
npx bb resize 375 812                           # iPhone-size
npx bb resize 1024 768                          # tablet
npx bb call viewport.resize '{"reset":true}'    # restore original
```

Uses CDP device emulation — the page re-renders at the new size immediately.

## Tab Management

Open and close tabs programmatically. Neither requires a session.

```bash
npx bb tab-create https://example.com     # open new tab
npx bb tab-create                          # open blank tab
npx bb tab-close 12345                     # close tab by ID
npx bb call tabs.create '{"url":"https://example.com","active":false}'
```

Typical workflow — compare two pages:
1. `tabs.list` to see current tabs
2. `tabs.create` with second URL
3. Inspect both tabs (each needs its own session)
4. `tabs.close` when done

## Accessibility Tree

Retrieve the full accessibility tree for the page. Useful for understanding semantic structure, finding interactive elements, and accessibility audits.

```bash
npx bb a11y-tree                   # default limits
npx bb a11y-tree 50 3              # max 50 nodes, depth 3
npx bb call dom.get_accessibility_tree '{"maxNodes":100,"maxDepth":5}'
```

Each node: `role`, `name`, `description`, `value`, `focused`, `required`, `checked`, `disabled`, `interactive`, `childIds`.

Typical workflow — find interactive controls:
1. `dom.get_accessibility_tree` with small `maxNodes`
2. Scan for nodes with `interactive: true`
3. Use role/name to identify the right control
4. `dom.find_by_role` to get an `elementRef` for interaction

## Network Monitoring

Read intercepted fetch/XHR requests. The interceptor auto-installs on first call.

```bash
npx bb network                     # recent requests
npx bb network 50                  # last 50
npx bb call page.get_network '{"limit":20,"clear":true}'
```

Each entry: `method`, `url`, `status`, `duration`, `initiator`.

Typical workflow — debug API calls:
1. `page.get_network` to see recent requests
2. Filter by URL pattern or status code
3. Cross-reference with `page.get_console` for errors
4. Use `page.evaluate` to replay or inspect response data

## Form Controls

**Checkbox/radio:**
```bash
npx bb call input.set_checked '{"target":{"elementRef":"el_123"},"checked":true}'
```

**Select dropdown:**
```bash
npx bb call input.select_option '{"target":{"elementRef":"el_456"},"values":["us"]}'
```

Select by value, label, or index. Multiple values for multi-select.

## Hover

Dispatch mouse events to trigger CSS `:hover` rules, tooltip display, dropdown menus, etc.

```bash
npx bb hover el_abc123
npx bb call input.hover '{"target":{"elementRef":"el_abc123"}}'
```

**Hold hover for inspection:** set `duration` (ms) to keep hover active before auto-releasing with `mouseleave`:
```bash
npx bb call input.hover '{"target":{"elementRef":"el_abc123"},"duration":2000}'
```

Typical workflow — inspect a tooltip:
1. `dom.query` to find the trigger element → `elementRef`
2. `input.hover` with `duration: 2000`
3. While hover holds, `dom.query` for tooltip content (e.g. `[role="tooltip"]`)
4. `styles.get_computed` on tooltip to verify positioning

## Drag and Drop

Full drag-and-drop requires source and destination element refs:

```bash
npx bb call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"}}'
```

With pixel offsets for precise positioning:
```bash
npx bb call input.drag '{"source":{"elementRef":"el_src"},"destination":{"elementRef":"el_dst"},"sourceOffset":{"x":10,"y":10},"destinationOffset":{"x":5,"y":5}}'
```

Event sequence: `mousedown → dragstart → drag → dragenter → dragover → drop → dragend → mouseup`.

Typical workflow — reorder a list:
1. `dom.query` to find draggable items → get source and destination `elementRef` values
2. `input.drag` from source to destination
3. `dom.wait_for` to confirm the DOM updated
4. `dom.query` to verify new order

## Finding Elements

### By text content
Find elements matching visible text. Faster than `dom.query` when you know the label:
```bash
npx bb find 'Submit Order'
npx bb call dom.find_by_text '{"text":"Add to Cart","scope":"button","exact":false}'
```
- `scope`: optional CSS selector to narrow search (e.g. `"button"`, `".sidebar"`)
- `exact`: `true` for exact match, `false` (default) for substring/case-insensitive

### By ARIA role
Find elements by explicit `role` attribute or implicit HTML role (e.g. `<nav>` → `navigation`):
```bash
npx bb find-role button 'Save'
npx bb call dom.find_by_role '{"role":"navigation"}'
npx bb call dom.find_by_role '{"role":"heading","name":"Dashboard"}'
```

## Waiting

### Wait for DOM condition
```bash
npx bb wait '.success-message' 10000
npx bb call dom.wait_for '{"selector":".modal","state":"visible","timeoutMs":10000}'
npx bb call dom.wait_for '{"selector":".spinner","state":"detached","timeoutMs":5000}'
```
- `state`: `attached` (exists in DOM), `detached` (removed), `visible` (non-zero size), `hidden`
- Uses MutationObserver + 250 ms polling fallback
- Returns `{found, elementRef, duration}` — NOT an error on timeout

### Wait for page load
```bash
npx bb call page.wait_for_load_state '{"timeoutMs":10000}'
```
Use after clicking navigation links.

## Interaction Flow

1. **Find target**: `dom.find_by_text`, `dom.find_by_role`, or `dom.query` → get `elementRef`
2. **Focus** if needed: `input.focus` (for keyboard input)
3. **Act**: `click`, `type`, `press_key`, `hover`, `drag`, etc.
4. **Wait**: `dom.wait_for` if action triggers async updates
5. **Verify**: `dom.describe`, `styles.get_computed`, or `page.get_console` for errors

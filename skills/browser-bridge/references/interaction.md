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

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

## Navigation

```bash
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

## Interaction Flow

1. `dom.query` to find target element → get `elementRef`
2. `input.focus` if needed (for keyboard input)
3. Perform action (`click`, `type`, `press_key`, etc.)
4. Verify result with `dom.describe` or `styles.get_computed`

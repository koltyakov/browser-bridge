# MCP vs CLI

This document compares the two Browser Bridge integration paths:
**MCP (Model Context Protocol)** and the **CLI skill**.

Short version:

- Choose MCP when your agent supports it.
- Choose the CLI skill when shell-native `bbx` control is the point.
- Do not install both by default unless you have a clear reason.

## Overview

| Aspect                    | MCP                           | CLI Skill                        |
| ------------------------- | ----------------------------- | -------------------------------- |
| **Integration Type**      | Native tool protocol          | Shell command execution          |
| **Primary Use Case**      | Agents with MCP support       | Shell-capable agents             |
| **Discovery**             | Auto-discovered tools         | Skill documentation              |
| **Invocation**            | Tool calls                    | `bbx` commands                   |
| **Sandbox Compatibility** | Excellent (no shell required) | Variable (requires shell access) |

## Capability Matrix

### Core Bridge Operations

| Capability | MCP Tool | CLI Command | Notes |
|------------|----------|-------------|-------|
| Health check | `browser_status`, `browser_health` | `bbx status`, `bbx doctor` | CLI has separate status/doctor |
| Request access | `browser_access` | `bbx access-request` | Surfaces Enable prompt in extension UI |
| Setup status | `browser_setup` | `bbx doctor` | Check MCP/skill installation |
| Request logs | `browser_logs` | `bbx logs` | Equivalent |
| Runtime presets | `browser_skill` | `bbx skill` | Equivalent |
| Heuristic investigation | `browser_investigate` | `bbx batch` / `bbx call` sequence | MCP has a dedicated read-only tool; CLI uses scripted structured reads |

### Tab Management

| Capability     | MCP Tool                      | CLI Command             | Notes                                 |
| -------------- | ----------------------------- | ----------------------- | ------------------------------------- |
| List tabs      | `browser_tabs` (list)         | `bbx tabs`              | Equivalent                            |
| Create tab     | `browser_tabs` (create)       | `bbx tab-create [url]`  | CLI shortcut                          |
| Close tab      | `browser_tabs` (close)        | `bbx tab-close <tabId>` | CLI shortcut                          |
| Tab activation | `browser_tabs` (active param) | `bbx call tabs.create`  | CLI needs raw call for `active` param |

### DOM Inspection

| Capability         | MCP Tool                           | CLI Command                   | Notes        |
| ------------------ | ---------------------------------- | ----------------------------- | ------------ |
| Query DOM          | `browser_dom` (query)              | `bbx dom-query [selector]`    | Equivalent   |
| Describe element   | `browser_dom` (describe)           | `bbx describe <ref>`          | Equivalent   |
| Get text content   | `browser_dom` (text)               | `bbx text <ref>`              | Equivalent   |
| Get HTML           | `browser_dom` (html)               | `bbx html <ref>`              | Equivalent   |
| Get attributes     | `browser_dom` (attributes)         | `bbx attrs <ref> [attr1,...]` | CLI shortcut |
| Wait for element   | `browser_dom` (wait)               | `bbx wait <selector>`         | Equivalent   |
| Find by text       | `browser_dom` (find_text)          | `bbx find <text>`             | Equivalent   |
| Find by ARIA role  | `browser_dom` (find_role)          | `bbx find-role <role>`        | Equivalent   |
| Accessibility tree | `browser_dom` (accessibility_tree) | `bbx a11y-tree`               | Equivalent   |

### Styles & Layout

| Capability        | MCP Tool                                | CLI Command                | Notes             |
| ----------------- | --------------------------------------- | -------------------------- | ----------------- |
| Computed styles   | `browser_styles_layout` (computed)      | `bbx styles <ref> [props]` | Equivalent        |
| Matched CSS rules | `browser_styles_layout` (matched_rules) | `bbx matched-rules <ref>`  | CLI shortcut      |
| Box model         | `browser_styles_layout` (box_model)     | `bbx box <ref>`            | Equivalent        |
| Hit test          | `browser_styles_layout` (hit_test)      | `bbx call layout.hit_test` | CLI uses raw call |

### Page State

| Capability          | MCP Tool                       | CLI Command                         | Notes             |
| ------------------- | ------------------------------ | ----------------------------------- | ----------------- |
| Page state          | `browser_page` (state)         | `bbx call page.get_state`           | CLI uses raw call |
| JavaScript evaluate | `browser_page` (evaluate)      | `bbx eval <expression>`             | Equivalent        |
| Console output      | `browser_page` (console)       | `bbx console [level]`               | Equivalent        |
| Wait for load       | `browser_page` (wait_for_load) | `bbx call page.wait_for_load_state` | CLI uses raw call |
| Browser storage     | `browser_page` (storage)       | `bbx storage [type] [keys]`         | Equivalent        |
| Page text           | `browser_page` (text)          | `bbx page-text [budget]`            | Equivalent        |
| Network requests    | `browser_page` (network)       | `bbx network [limit]`               | Equivalent        |
| Performance metrics | `browser_page` (performance)   | `bbx perf`                          | Equivalent        |

### Navigation

| Capability      | MCP Tool                          | CLI Command               | Notes        |
| --------------- | --------------------------------- | ------------------------- | ------------ |
| Navigate to URL | `browser_navigation` (navigate)   | `bbx navigate <url>`      | Equivalent   |
| Reload page     | `browser_navigation` (reload)     | `bbx reload`              | CLI shortcut |
| Go back         | `browser_navigation` (go_back)    | `bbx back`                | CLI shortcut |
| Go forward      | `browser_navigation` (go_forward) | `bbx forward`             | CLI shortcut |
| Scroll viewport | `browser_navigation` (scroll)     | `bbx scroll <top> [left]` | CLI shortcut |
| Resize viewport | `browser_navigation` (resize)     | `bbx resize <w> <h>`      | Equivalent   |

### Input & Interaction

| Capability              | MCP Tool                           | CLI Command                       | Notes             |
| ----------------------- | ---------------------------------- | --------------------------------- | ----------------- |
| Click element           | `browser_input` (click)            | `bbx click <ref> [button]`        | Equivalent        |
| Focus element           | `browser_input` (focus)            | `bbx focus <ref>`                 | Equivalent        |
| Type text               | `browser_input` (type)             | `bbx type <ref> <text>`           | Equivalent        |
| Press key               | `browser_input` (press_key)        | `bbx press-key <key> [ref]`       | Equivalent        |
| Set checked             | `browser_input` (set_checked)      | `bbx call input.set_checked`      | CLI uses raw call |
| Select option           | `browser_input` (select_option)    | `bbx call input.select_option`    | CLI uses raw call |
| Hover                   | `browser_input` (hover)            | `bbx hover <ref>`                 | Equivalent        |
| Drag                    | `browser_input` (drag)             | `bbx call input.drag`             | CLI uses raw call |
| Scroll target into view | `browser_input` (scroll_into_view) | `bbx call input.scroll_into_view` | CLI uses raw call |

### Patching

| Capability        | MCP Tool                          | CLI Command                         | Notes                          |
| ----------------- | --------------------------------- | ----------------------------------- | ------------------------------ |
| Apply style patch | `browser_patch` (apply_styles)    | `bbx patch-style <ref> prop=val...` | Equivalent                     |
| Apply DOM patch   | `browser_patch` (apply_dom)       | `bbx patch-text <ref> <text>`       | CLI has text-specific shortcut |
| List patches      | `browser_patch` (list)            | `bbx patches`                       | Equivalent                     |
| Rollback patch    | `browser_patch` (rollback)        | `bbx rollback <patchId>`            | Equivalent                     |
| Commit baseline   | `browser_patch` (commit_baseline) | `bbx call patch.commit_baseline`    | CLI uses raw call              |

### Capture & Screenshots

| Capability           | MCP Tool                                | CLI Command                                 | Notes             |
| -------------------- | --------------------------------------- | ------------------------------------------- | ----------------- |
| Element screenshot   | `browser_capture` (element)             | `bbx screenshot <ref> [outPath]`            | Equivalent        |
| Region screenshot    | `browser_capture` (region)              | `bbx call screenshot.capture_region`        | CLI uses raw call |
| Full-page screenshot | `browser_capture` (full_page)           | `bbx call screenshot.capture_full_page`     | CLI uses raw call |
| CDP document         | `browser_capture` (cdp_document)        | `bbx call cdp.get_document`                 | CLI uses raw call |
| CDP DOM snapshot     | `browser_capture` (cdp_dom_snapshot)    | `bbx call cdp.get_dom_snapshot`             | CLI uses raw call |
| CDP box model        | `browser_capture` (cdp_box_model)       | `bbx call cdp.get_box_model`                | CLI uses raw call |
| CDP computed styles  | `browser_capture` (cdp_computed_styles) | `bbx call cdp.get_computed_styles_for_node` | CLI uses raw call |

### Advanced & Raw Protocol

| Capability | MCP Tool | CLI Command | Notes |
|------------|----------|-------------|-------|
| Raw protocol call | `browser_call` | `bbx call <method> '{...}'` | Equivalent |
| Ordered batch calls | `browser_batch` | `bbx batch '[{...}]'` | Both preserve request order and return per-call `durationMs` / `approxTokens` |
| Batch parallel reads | N/A (multiple tool calls) | `bbx batch '[{...}]'` | CLI has explicit batch |
| Install manifest | N/A | `bbx install <ext-id>` | CLI-only (setup) |
| Install MCP config | N/A | `bbx install-mcp [client]` | CLI-only (setup) |
| Install skill | N/A | `bbx install-skill [client]` | CLI-only (setup) |
| Uninstall | N/A | `bbx uninstall` | CLI-only (setup) |

## Feature Comparison

### MCP Advantages

| Feature                  | Description                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------- |
| **Auto-discovery**       | Tools are automatically registered and discovered by MCP clients                      |
| **Schema validation**    | Input parameters validated via Zod schemas before execution                           |
| **Structured responses** | Consistent tool result format with content blocks                                     |
| **No shell dependency**  | Works in sandboxed environments without shell access                                  |
| **Tool grouping**        | Related actions grouped logically (e.g., `browser_dom` with multiple actions)         |
| **Type safety**          | Strong typing via input schemas                                                       |
| **Client-native**        | Integrated into agent's tool system natively                                          |
| **Delegation hints**     | `browser_investigate` can tell orchestrators to use a smaller, cheaper subagent first |

### CLI Advantages

| Feature                        | Description                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **Batch execution**            | `bbx batch` executes multiple calls concurrently via Promise.all and reports per-call duration/token estimates |
| **Request logging**            | `bbx logs` shows recent bridge request history                                                                 |
| **Setup commands**             | Built-in install, uninstall, doctor commands                                                                   |
| **Shell scripting**            | Can be used in scripts, pipes, and CI workflows                                                                |
| **Direct output**              | JSON output can be piped to other tools                                                                        |
| **Shortcut commands**          | Convenient aliases for common operations                                                                       |
| **Raw protocol access**        | Direct `bbx call` for any method with full parameter control                                                   |
| **Interactive flows**          | `bbx doctor` for guided troubleshooting                                                                        |
| **Stdin support**              | `bbx eval -` reads expression from stdin                                                                       |
| **Manual investigation loops** | `bbx batch` makes the same structured-first investigation pattern easy to script                               |

## Ergonomics Comparison

### MCP Tool Invocation

```
Tool: browser_dom
Parameters: { "action": "query", "selector": ".sidebar", "maxNodes": 20 }
```

### CLI Command Invocation

```bash
bbx dom-query .sidebar
# or with full control:
bbx call dom.query '{"selector": ".sidebar", "maxNodes": 20}'
```

### Open-Ended Investigation

MCP has a dedicated `browser_investigate` tool for "find out why this is broken" style requests. It is read-only and can carry delegation metadata for a smaller, cheaper subagent.

CLI does not have a separate `bbx investigate` command. The equivalent is a structured-first sequence, usually via one `bbx batch` call:

```bash
bbx batch '[
  {"method":"page.get_state"},
  {"method":"dom.query","params":{"selector":"main","maxNodes":20,"maxDepth":4,"textBudget":600}},
  {"method":"page.get_text","params":{"textBudget":4000}}
]'
```

Escalate to `bbx screenshot`, `screenshot.capture_region`, or `screenshot.capture_full_page` only when those structured reads are insufficient.

### Key Differences

| Aspect | MCP | CLI |
|--------|-----|-----|
| Parameter format | JSON object | CLI args or JSON string |
| Output format | Tool result content | `{ok, summary, evidence}` JSON |
| Error handling | Tool error response | JSON with `ok: false` |
| Version drift warnings | Returned in health/status output and surfaced automatically after connect | Returned in summaries and raw response metadata after connect |
| Access routing | Follows active tab in enabled window by default | Follows active tab in enabled window by default |
| Explicit targeting | `tabId` on grouped tools | `bbx call --tab <tabId> ...` |
| Concurrency | Multiple tool calls | `batch` command or parallel shells |

## Use Case Recommendations

### Prefer MCP When:

- Your agent has native MCP support (Claude Code, Cursor, Copilot, etc.)
- Running in sandboxed environments (GitHub Copilot, containerized agents)
- You want automatic tool discovery and schema validation
- You prefer grouped, semantic tool interfaces
- Integration with IDE tool systems is important

### Prefer CLI When:

- Your agent runs shell commands reliably
- You need batch execution of multiple reads
- You want access to setup/install commands
- You're debugging the bridge itself (`bbx logs`, `bbx doctor`)
- You're writing scripts or CI workflows
- You need stdin/stdout piping
- You prefer direct protocol access

## Client Compatibility Matrix

| Client         | MCP Support              | CLI Skill Support | Recommended Path             |
| -------------- | ------------------------ | ----------------- | ---------------------------- |
| OpenAI Codex   | Yes (TOML config)        | Yes               | MCP preferred                |
| Claude Code    | Yes                      | Yes               | MCP preferred                |
| Cursor         | Yes                      | Yes               | MCP preferred                |
| GitHub Copilot | Yes (VS Code)            | Limited (sandbox) | **MCP required**             |
| OpenCode       | Yes (local type)         | Yes               | MCP preferred                |
| Antigravity    | Yes                      | Yes               | MCP preferred                |
| Windsurf       | Yes                      | Yes               | MCP preferred                |
| Generic agents | Yes (`.agents/mcp.json`) | `.agents/skills/` | MCP preferred when available |

## Summary

Both MCP and CLI paths provide full access to Browser Bridge capabilities. The choice depends primarily on your agent's architecture:

1. **MCP** is the recommended path for agents with native MCP support, offering better integration, validation, and sandbox compatibility.

2. **CLI Skill** is ideal for shell-capable agents, scripting scenarios, and when you need batch operations or setup commands.

The underlying protocol is identical: both paths communicate with the same
native host and extension. Use `browser_call` (MCP) or `bbx call` (CLI) when
you need method-specific fields not exposed by the grouped tools or shortcut
commands.

---
name: browser-bridge
description: Operate the local Browser Bridge against a Chrome tab that has agent communication enabled in the extension UI and holds a user-authenticated session. Use when Codex needs token-efficient browser inspection, targeted partial screenshots, computed styles, CDP-backed DOM reads, or reversible DOM/CSS monkey patches through the extension instead of generic screenshot-heavy automation. When browser-bridge is available, do not fall back to Playwright or other browser automation tools; use browser-bridge capabilities only.
---

# Browser Bridge

Use this skill through a dedicated subagent whenever browser work depends on the installed Chrome extension and native bridge.

## Quick Start

1. Check the bridge status first.

```bash
node packages/agent-client/src/cli.js status
```

2. If the operator has not enabled the current tab yet, turn on agent communication in the extension popup or side panel. Then request access for the active tab.

```bash
node packages/agent-client/src/cli.js request-access
```

3. Read runtime guidance from the bridge when needed.

```bash
node packages/agent-client/src/cli.js skill
```

4. Prefer the generic call surface for arbitrary work after the tab is enabled and the session exists.

```bash
node packages/agent-client/src/cli.js call dom.query '{"selector":"body","maxNodes":8,"maxDepth":2}'
```

## Operating Rules

- Use a subagent for bridge calls and return only concise findings to the parent agent.
- When browser-bridge is the chosen tool, do not switch to Playwright or other browser automation; stay within browser-bridge capabilities.
- Treat the CLI as a thin transport: prefer generic `call` invocations over task-specific wrappers.
- The convenience commands cover only the common path. Use `call` for methods such as `page.get_state`, `navigation.*`, `viewport.scroll`, `dom.get_attributes`, `styles.get_matched_rules`, `layout.hit_test`, `input.set_checked`, `input.select_option`, `screenshot.capture_region`, `patch.commit_session_baseline`, and `cdp.*`.
- Use `call <method>` with the saved session for tab-bound methods unless an explicit session id is required.
- Use `page.get_state` before larger interactions when you need to confirm readiness, focus, or scroll position.
- Prefer `dom.query`, `dom.describe`, `styles.get_computed`, and `layout.get_box_model` before any screenshot call.
- Use `input.click`, `input.type`, `input.focus`, `input.press_key`, `input.set_checked`, and `input.select_option` for operator-approved page interaction.
- Keep `maxNodes`, `maxDepth`, `textBudget`, `attributeAllowlist`, and `styleAllowlist` tight.
- Treat every session as scoped to one enabled tab.
- Use `patch.apply_styles` before `patch.apply_dom` when testing a layout or visual fix.
- Roll back every patch before ending unless the user explicitly wants the mutated DOM left in place.
- Request screenshots only when structured data is insufficient to answer the question.

## Recommended Workflow

### 1. Confirm scope

- Call `status` or `session.get_status`.
- Include the tab id and current URL or origin in the subagent’s result summary.
- Stop if the bridge reports no extension connection or the session is expired.

### 2. Inspect cheaply

- Start with a narrow DOM query around a selector or existing `elementRef`.
- Ask only for the attributes and style properties needed to answer the question.
- If a follow-up is needed, reuse `elementRef` values instead of rescanning large DOM regions.
- Interact through `input.*` methods only after you have a precise target and the operator has enabled the tab.

See [references/token-efficiency.md](references/token-efficiency.md) for budgeting rules.

### 3. Patch carefully

- Use style patches first for spacing, overflow, visibility, alignment, and typography checks.
- Use DOM patches only for small reversible experiments such as text replacement, attribute toggles, or class toggles.
- After a patch, verify with `layout.get_box_model`, `styles.get_computed`, or a partial screenshot.

See [references/patch-workflow.md](references/patch-workflow.md) for the patch loop.

### 4. Escalate only when necessary

- Use CDP-backed reads when the content script view is insufficient.
- Use screenshots only for ambiguous visual issues and keep the crop small.
- Use `skill` to read the runtime guidance if you need the current protocol-level recommended flow.

See [references/protocol.md](references/protocol.md) for the RPC surface.

## Output Style For The Subagent

Return:
- the answer or verdict
- the session scope: tab id and current URL or origin
- the smallest evidence set that justifies the answer
- artifact paths only if the payload is too large to inline

Do not return raw HTML dumps, full DOM snapshots, or large base64 images to the parent agent unless explicitly requested.

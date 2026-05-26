# Agent Permissions

Browser Bridge exposes many browser actions. In permission-ask agent hosts, approving every individual action is noisy. Prefer a server-wide or command-prefix rule when the host supports it.

Permission prompts are enforced by the agent host, not by Browser Bridge. Browser Bridge can suggest safer defaults and expose the generic `browser_call` MCP tool, but it cannot make a host's permission dialog approve every BBX tool unless that host supports such a rule.

## Recommended Policy

- **MCP mode:** allow the Browser Bridge MCP server once, or approve the generic `browser_call` tool once when server-wide approval is not available.
- **CLI mode:** allow the `bbx` command prefix rather than each exact `bbx status`, `bbx tabs`, or `bbx call ...` command.
- **Fallback:** if a host only offers per-tool approvals, ask the agent to use `browser_call` for MCP workflows. That keeps the approval surface to one MCP tool while still reaching the full bridge protocol.

## Browser Bridge Names

- MCP server id installed by BBX: `browser-bridge`
- Generic MCP tool: `browser_call`
- Claude Code MCP allow names: `mcp__browser-bridge` and `mcp__browser-bridge__*`
- CLI command prefix: `bbx`

## Claude Code

Claude Code documents permission rules in `~/.claude/settings.json`, project `.claude/settings.json`, or local project `.claude/settings.local.json`. It also documents MCP rules where `mcp__<server>` matches any tool from that server and `mcp__<server>__*` is the wildcard form.

For MCP mode, add a server-wide allow rule:

```json
{
  "permissions": {
    "allow": ["mcp__browser-bridge", "mcp__browser-bridge__*"]
  }
}
```

For CLI mode, allow the `bbx` command prefix:

```json
{
  "permissions": {
    "allow": ["Bash(bbx *)"]
  }
}
```

Notes:

- Claude's interactive "don't ask again" prompt may save exact tool names such as `mcp__browser-bridge__browser_status`. Manual server-wide rules are more reliable for BBX.
- Restart Claude Code if the running session does not pick up settings changes.

Sources: [Claude Code permissions](https://docs.anthropic.com/en/docs/claude-code/permissions), [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings).

## OpenAI Codex

Codex stores user config at `~/.codex/config.toml` and project config at `.codex/config.toml` for trusted projects. Codex documents MCP server approval settings on each `mcp_servers.<id>` entry.

For MCP mode, approve Browser Bridge tools at the MCP server level:

```toml
[mcp_servers.browser-bridge]
command = "bbx"
args = ["mcp", "serve"]
default_tools_approval_mode = "approve"
```

If your existing config uses a quoted table name, keep that style:

```toml
[mcp_servers."browser-bridge"]
command = "bbx"
args = ["mcp", "serve"]
default_tools_approval_mode = "approve"
```

For CLI mode, add a Codex rules file such as `~/.codex/rules/default.rules`:

```python
prefix_rule(
    pattern = ["bbx"],
    decision = "allow",
    justification = "Allow Browser Bridge CLI commands"
)
```

Notes:

- Codex also supports per-tool MCP overrides with `mcp_servers.<id>.tools.<tool>.approval_mode`, but BBX usually wants the server-level default.
- If a project config is untrusted, Codex ignores project `.codex/` layers. Put user-wide BBX permission defaults in `~/.codex/config.toml` or `~/.codex/rules/default.rules`.

Sources: [Codex config basics](https://developers.openai.com/codex/config-basic), [Codex config reference](https://developers.openai.com/codex/config-reference), [Codex rules](https://developers.openai.com/codex/rules).

## GitHub Copilot In VS Code

VS Code and GitHub Copilot document MCP configuration in workspace `.vscode/mcp.json` or user-profile MCP configuration opened through **MCP: Open User Configuration**. The documented flow asks users to trust the MCP server when it starts, and Copilot may still ask to confirm individual tool invocations.

There is no documented VS Code/Copilot setting equivalent to Claude's `mcp__browser-bridge__*` or Codex's `default_tools_approval_mode = "approve"` for all tools from one MCP server.

Recommended BBX approach:

- Use MCP mode instead of shelling out to `bbx` in Copilot, because Copilot shells are often sandboxed.
- Let Browser Bridge's MCP instructions steer the agent to `browser_call` in permission-ask contexts so the first approval covers the generic BBX tool rather than each specialized tool.
- Use VS Code's **Configure Tools** UI to keep only Browser Bridge tools you actually want enabled.
- If you enable VS Code MCP sandboxing for a local stdio server, VS Code documents that sandboxed tool calls are auto-approved, but the sandbox must still allow the Browser Bridge MCP server to reach the local daemon socket. Test before relying on this.

Sources: [GitHub Copilot MCP docs](https://docs.github.com/en/copilot/customizing-copilot/using-model-context-protocol/extending-copilot-chat-with-mcp), [VS Code MCP servers](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

## Cursor

Cursor supports MCP, and Browser Bridge can install Cursor MCP config globally or per project. Public Cursor docs are frequently rendered client-side and do not currently expose a documented wildcard permission rule equivalent to Claude's MCP allow syntax in the pages Browser Bridge can verify.

Recommended BBX approach:

- Prefer MCP mode when Cursor exposes Browser Bridge tools.
- If Cursor prompts per tool, ask it to use `browser_call` for BBX operations so only one Browser Bridge MCP tool needs approval.
- For CLI-skill mode, configure Cursor's shell-command permissions if your Cursor version exposes them, using a `bbx *` command-prefix allow rule. Verify the exact syntax in Cursor's current settings UI before sharing it with a team.

Source checked: [Cursor docs](https://docs.cursor.com/).

## OpenCode

OpenCode stores global config at `~/.config/opencode/opencode.json` and project config in `opencode.json`. OpenCode documents `permission` rules with wildcard matching. By default, OpenCode allows most operations; prompts usually appear only after you configure stricter permissions such as `"*": "ask"` or `"bash": "ask"`.

For CLI mode with stricter permissions, allow the `bbx` command prefix:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "*": "ask",
      "bbx *": "allow"
    }
  }
}
```

For MCP mode, OpenCode's public permission docs list built-in permission keys such as `bash`, `edit`, `read`, `webfetch`, and `task`; they do not document a per-MCP-server wildcard permission key. If you configure OpenCode to ask for MCP tools, prefer `browser_call` as the BBX MCP tool.

Sources: [OpenCode config](https://opencode.ai/docs/config/), [OpenCode permissions](https://opencode.ai/docs/permissions/).

## Windsurf

Windsurf documents MCP config at `~/.codeium/windsurf/mcp_config.json`. Its MCP UI lets users enable or disable individual tools for a server, and team admins can whitelist MCP servers by server id and config pattern. The public docs do not document a user-level wildcard approval rule for all tools from one MCP server.

Recommended BBX approach:

- Use the Windsurf MCP tool toggles to enable the BBX tools you want.
- In permission-ask workflows, ask Cascade to use `browser_call` for Browser Bridge operations to avoid separate prompts for every specialized BBX tool.
- For team control, whitelist the `browser-bridge` MCP server id and its expected command/args in Windsurf team settings if your organization restricts MCP servers.

Source: [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp).

## Antigravity

Browser Bridge supports Antigravity MCP config generation, but Browser Bridge could not verify a public Antigravity permission-rule reference that documents wildcard approval for all tools from one MCP server.

Recommended BBX approach:

- Use MCP mode when Antigravity discovers Browser Bridge.
- If Antigravity prompts per MCP tool, ask the agent to use `browser_call` for BBX operations.
- If your Antigravity version exposes MCP server trust or allow-list settings, prefer a server-wide allow for `browser-bridge` over individual BBX tools.

Source checked: [Antigravity](https://antigravity.google/).

## Generic `.agents` Layouts

Generic `.agents` integrations are not a single product, so permission syntax depends on the runtime.

Use these patterns as the intent to translate into that runtime's settings:

```text
MCP server allow: browser-bridge
MCP tool wildcard: browser-bridge/* or mcp__browser-bridge__*
Generic BBX MCP tool: browser_call
CLI command prefix: bbx *
```

If the runtime has no wildcard or server-wide allow concept, prefer `browser_call` for MCP and `bbx call <method>` for CLI so the number of distinct approval entries stays small.

## Security Notes

Allowing all BBX commands or all Browser Bridge MCP tools lets the agent inspect and interact with the currently enabled browser window. Browser Bridge still requires the extension's window-scoped Enable action before tab-bound calls can read or mutate a page.

Do not combine broad BBX approval with unrelated broad shell approval unless you intend to trust the agent with general local command execution. A focused `bbx *` or Browser Bridge MCP server allow rule is safer than allowing all shell commands or all MCP servers.

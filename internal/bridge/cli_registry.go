package bridge

import "strings"

type cliCommandDefinition struct {
	name, method, usage, category      string
	localOnly, file, target, summarize bool
	parse                              func(*cliShortcutArgs)
}

// Command identity, routing policy, argument parser and output mode belong in
// one definition. Runtime orchestration stays in the CLI's command handlers.
var cliCommands = []cliCommandDefinition{
	{name: "status", method: "health.ping"},
	{name: "tabs", method: "tabs.list"},
	{name: "logs", method: "log.tail"},
	{name: "access-request", method: "access.request", usage: "bbx access-request [intent]", parse: parseAccessShortcut},
	{name: "dom-query", method: "dom.query", parse: func(a *cliShortcutArgs) {
		a.params["selector"] = value("body")
		a.put("selector", 0)
	}},
	{name: "describe", method: "dom.describe", target: true, summarize: true},
	{name: "text", method: "dom.get_text", target: true, summarize: true, parse: func(a *cliShortcutArgs) { a.number("textBudget", "budget", 1, true) }},
	{name: "styles", method: "styles.get_computed", target: true, summarize: true, parse: shortcutList("properties")},
	{name: "box", method: "layout.get_box_model", target: true, summarize: true},
	{name: "click", method: "input.click", target: true, parse: func(a *cliShortcutArgs) { a.put("button", 1) }},
	{name: "focus", method: "input.focus", target: true},
	{name: "type", method: "input.type", target: true, parse: shortcutText("text", nil)},
	{name: "fill", method: "input.fill", target: true, parse: shortcutText("value", object{"mode": value("auto")})},
	{name: "hover", method: "input.hover", target: true},
	{name: "html", method: "dom.get_html", target: true, parse: func(a *cliShortcutArgs) { a.number("maxLength", "maxLen", 1, true) }},
	{name: "patch-style", method: "patch.apply_styles", target: true, parse: parseStyleShortcut},
	{name: "patch-text", method: "patch.apply_dom", target: true, parse: shortcutText("value", object{"operation": value("set_text")})},
	{name: "patches", method: "patch.list", summarize: true},
	{name: "rollback", method: "patch.rollback", usage: "rollback <patchId>", parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.put("patchId", 0)
	}},
	{name: "console", method: "page.get_console", summarize: true, parse: func(a *cliShortcutArgs) {
		a.params["level"], a.params["clear"] = value("all"), value(false)
		a.put("level", 0)
	}},
	{name: "wait", method: "dom.wait_for", usage: "wait <selector> [timeoutMs]", parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.put("selector", 0)
		a.params["timeoutMs"] = value(5000)
		a.number("timeoutMs", "timeoutMs", 1, true)
	}},
	{name: "find", method: "dom.find_by_text", usage: "find <text>", summarize: true, parse: func(a *cliShortcutArgs) {
		text := strings.Join(a.args, " ")
		if text == "" {
			a.require(0)
		} else {
			a.params["text"] = value(text)
		}
	}},
	{name: "find-role", method: "dom.find_by_role", usage: "find-role <role> [name]", summarize: true, parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.put("role", 0)
		if len(a.args) > 1 && strings.Join(a.args[1:], " ") != "" {
			a.params["name"] = value(strings.Join(a.args[1:], " "))
		}
	}},
	{name: "navigate", method: "navigation.navigate", usage: "navigate <url>", parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.put("url", 0)
	}},
	{name: "storage", method: "page.get_storage", parse: parseStorageShortcut},
	{name: "page-text", method: "page.get_text", summarize: true, parse: func(a *cliShortcutArgs) { a.number("textBudget", "textBudget", 0, true) }},
	{name: "network", method: "page.get_network", summarize: true, parse: func(a *cliShortcutArgs) { a.number("limit", "limit", 0, true) }},
	{name: "a11y-tree", method: "dom.get_accessibility_tree", parse: func(a *cliShortcutArgs) {
		a.number("maxNodes", "maxNodes", 0, true)
		a.number("maxDepth", "maxDepth", 1, true)
	}},
	{name: "perf", method: "performance.get_metrics"},
	{name: "scroll", method: "viewport.scroll", usage: "scroll <top> [left]", parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.number("top", "top", 0, false)
		a.number("left", "left", 1, false)
	}},
	{name: "resize", method: "viewport.resize", usage: "resize <width> <height>", parse: func(a *cliShortcutArgs) {
		a.require(1)
		a.number("width", "width", 0, true)
		a.number("height", "height", 1, true)
	}},
	{name: "reload", method: "navigation.reload"},
	{name: "back", method: "navigation.go_back"},
	{name: "forward", method: "navigation.go_forward"},
	{name: "attrs", method: "dom.get_attributes", target: true, summarize: true, parse: shortcutList("attributes")},
	{name: "matched-rules", method: "styles.get_matched_rules", target: true, summarize: true},
	{name: "tab-create", method: "tabs.create", parse: func(a *cliShortcutArgs) { a.put("url", 0) }},
	{name: "tab-close", method: "tabs.close", usage: "tab-close <tabId>", parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.number("tabId", "tabId", 0, true)
	}},
	{name: "tab-activate", method: "tabs.activate", usage: "tab-activate <tabId>", parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.number("tabId", "tabId", 0, true)
	}},
	{name: "press-key", method: "input.press_key", usage: "press-key <key> [ref|selector]", parse: parseKeyShortcut},
	{name: "cdp-press-key", method: "cdp.dispatch_key_event", usage: "cdp-press-key [--tab <tabId>] <key> [code]", summarize: true, parse: func(a *cliShortcutArgs) {
		a.require(0)
		a.put("key", 0)
		a.put("code", 1)
	}},
	{name: "install", localOnly: true, category: "Setup", usage: "install [extension-id] [--browser <browser>|--all]"},
	{name: "install-self", localOnly: true, category: "Setup", usage: "install-self [--bin-dir <directory>] [--no-restart]"},
	{name: "uninstall", localOnly: true, category: "Setup", usage: "uninstall"},
	{name: "install-skill", localOnly: true, category: "Setup", usage: "install-skill [targets] [--global|--local]"},
	{name: "install-mcp", localOnly: true, category: "Setup", usage: "install-mcp [targets] [--global|--local]"},
	{name: "mcp", localOnly: true, category: "Setup", usage: "mcp serve | mcp config"},
	{name: "doctor", localOnly: true, category: "Setup", usage: "doctor"},
	{name: "restart", localOnly: true, category: "Setup", usage: "restart"},
	{name: "update", localOnly: true, category: "Updates", usage: "update [check|apply|install|repair|rollback|status]"},
	{name: "config", localOnly: true, category: "Configuration", usage: "config get auto-update | config set auto-update off|compatible"},
	{name: "remote", localOnly: true, category: "Destinations", usage: "remote add|remove|list|test|destinations"},
	{name: "proxy", localOnly: true, category: "Destinations", usage: "proxy enable|disable|status"},
	{name: "call", category: "RPC", usage: "call [--extension ID] [--browser NAME] [--profile LABEL] [--tab ID] [--preset quick|normal|deep] METHOD [JSON|-]"},
	{name: "batch", category: "Batch", usage: "batch [--preset quick|normal|deep] [--evidence-only] JSON"},
	{name: "protocol", localOnly: true, category: "Protocol", usage: "protocol describe [method|group]"},
	{name: "protocol.describe", localOnly: true},
	{name: "skill", localOnly: true, category: "Protocol", usage: "skill"},
	{name: "upload", file: true, category: "Files", usage: "upload --tab <id> <ref|selector> <local-file>..."},
	{name: "paste-image", file: true, category: "Files", usage: "paste-image --tab <id> <ref|selector> <local-file>"},
	{name: "download", file: true, category: "Files", usage: "download --tab <id> <url> <outPath>"},
	{name: "screenshot", file: true, category: "Files", usage: "screenshot"},
	{name: "har", file: true, category: "Files", usage: "har"},
	{name: "record", file: true, category: "Files", usage: "record --tab <id> <options-json> <out.json|out.html|out.mp4>"},
	{name: "replay", file: true, category: "Files", usage: "replay"},
	{name: "intercept", category: "Other commands", usage: "intercept add|remove|list|clear"},
	{name: "eval", category: "Other commands", usage: "eval [--await] EXPRESSION"},
	{name: "help", localOnly: true}, {name: "--help", localOnly: true}, {name: "-h", localOnly: true},
	{name: "--version", localOnly: true}, {name: "-v", localOnly: true}, {name: "--self-test", localOnly: true},
	{name: "--bridge-daemon", localOnly: true}, {name: "--native-host", localOnly: true},
}

func cliCommandByName(name string) *cliCommandDefinition {
	for i := range cliCommands {
		if cliCommands[i].name == name {
			return &cliCommands[i]
		}
	}
	return nil
}

var shortcutMethods = func() map[string]string {
	methods := map[string]string{}
	for _, command := range cliCommands {
		if command.method != "" {
			methods[command.name] = command.method
		}
	}
	return methods
}()

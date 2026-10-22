package bridge

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

var installAgentNames = []string{"codex", "claude", "cursor", "copilot", "opencode", "antigravity", "windsurf", "agents"}
var installAgentLabels = map[string]string{"codex": "OpenAI Codex", "claude": "Claude Code", "cursor": "Cursor", "copilot": "GitHub Copilot", "opencode": "OpenCode", "antigravity": "Antigravity", "windsurf": "Windsurf", "agents": "Generic agents"}

type installScope struct {
	global  bool
	project string
	home    string
}

func installCurrentScope() (installScope, error) {
	home, err := installUserHome()
	if err != nil {
		return installScope{}, err
	}
	project, err := os.Getwd()
	return installScope{global: true, project: project, home: home}, err
}

func installMCPPath(client string, scope installScope) string {
	if !scope.global {
		paths := map[string]string{"codex": ".codex/config.toml", "claude": ".mcp.json", "cursor": ".cursor/mcp.json", "copilot": ".vscode/mcp.json", "opencode": "opencode.json", "antigravity": ".agents/mcp_config.json", "windsurf": ".windsurf/mcp_config.json", "agents": ".agents/mcp.json"}
		return filepath.Join(scope.project, filepath.FromSlash(paths[client]))
	}
	if client == "codex" && os.Getenv("CODEX_HOME") != "" {
		return filepath.Join(os.Getenv("CODEX_HOME"), "config.toml")
	}
	paths := map[string]string{"codex": ".codex/config.toml", "claude": ".claude.json", "cursor": ".cursor/mcp.json", "copilot": ".copilot/mcp-config.json", "opencode": ".config/opencode/opencode.json", "antigravity": ".gemini/antigravity/mcp_config.json", "windsurf": ".codeium/windsurf/mcp_config.json", "agents": ".agents/mcp.json"}
	return filepath.Join(scope.home, filepath.FromSlash(paths[client]))
}

func installVSCodeHome(scope installScope) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(scope.home, "Library", "Application Support", "Code")
	case "windows":
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(scope.home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "Code")
	default:
		return filepath.Join(scope.home, ".config", "Code")
	}
}

func installMCPPaths(client string, scope installScope) []string {
	paths := []string{installMCPPath(client, scope)}
	if client != "copilot" || !scope.global {
		return paths
	}
	user := filepath.Join(installVSCodeHome(scope), "User")
	paths = append(paths, filepath.Join(user, "mcp.json"))
	profiles := filepath.Join(user, "profiles")
	entries, err := os.ReadDir(profiles)
	if err != nil {
		return paths
	}
	for _, entry := range entries {
		if entry.IsDir() {
			paths = append(paths, filepath.Join(profiles, entry.Name(), "mcp.json"))
		}
	}
	return paths
}

func installMCPKey(client, path string, scope installScope) string {
	switch client {
	case "codex":
		return "mcp_servers"
	case "opencode":
		return "mcp"
	case "copilot":
		if filepath.Clean(path) != filepath.Join(scope.home, ".copilot", "mcp-config.json") {
			return "servers"
		}
	}
	return "mcpServers"
}

func installMCPEntry(client string) object {
	if client == "opencode" {
		return object{"type": value("local"), "command": value([]string{"bbx", "mcp", "serve"})}
	}
	entry := object{"command": value("bbx"), "args": value([]string{"mcp", "serve"}), "env": value(object{})}
	if client == "claude" || client == "copilot" || client == "agents" {
		entry["type"] = value("stdio")
	}
	return entry
}

func installUpdateJSONConfig(raw, client, path string, scope installScope, remove bool) (string, error) {
	root, err := installParseJSON(raw)
	if err != nil {
		return "", err
	}
	key := installMCPKey(client, path, scope)
	if block := installJSONLookup(root, key); block != nil && block.kind != '{' {
		return "", fmt.Errorf("%s must be an object", key)
	}
	keys := []string{key, "browser-bridge"}
	if remove {
		return installJSONEdit(raw, keys, nil)
	}
	existing := installJSONLookup(root, keys...)
	entry := installMCPEntry(client)
	if existing == nil {
		replacement := string(value(entry))
		return installJSONEdit(raw, keys, &replacement)
	}
	if existing.kind != '{' {
		return "", fmt.Errorf("browser-bridge configuration must be an object")
	}
	// Preserve environment variables, disabled flags and custom timeouts.
	fields := []string{"type", "command", "args", "env"}
	for _, field := range fields {
		v, exists := entry[field]
		if !exists {
			continue
		}
		if field == "env" && installJSONLookup(existing, field) != nil {
			continue
		}
		replacement := string(v)
		raw, err = installJSONEdit(raw, []string{key, "browser-bridge", field}, &replacement)
		if err != nil {
			return "", err
		}
	}
	return raw, nil
}

type installTOMLStatement struct {
	start, end, valueEnd int
	text                 string
}

// Scan complete TOML statements, respecting arrays, inline tables, strings and
// multiline strings. Headers inside string values must never become sections.
func installTOMLStatements(raw string) ([]installTOMLStatement, error) {
	statements := []installTOMLStatement{}
	start, end, square, curly := 0, 0, 0, 0
	quote := byte(0)
	triple, escape, comment := false, false, false
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if comment {
			if c != '\n' {
				continue
			}
			comment = false
		} else if quote != 0 {
			end = i + 1
			if escape {
				escape = false
				continue
			}
			if quote == '"' && c == '\\' {
				escape = true
				continue
			}
			if c == quote {
				if !triple {
					quote = 0
				} else if i+2 < len(raw) && raw[i+1] == quote && raw[i+2] == quote {
					i += 2
					end = i + 1
					quote = 0
					triple = false
				}
			}
			continue
		} else {
			switch c {
			case '#':
				comment = true
				continue
			case '"', '\'':
				quote = c
				if i+2 < len(raw) && raw[i+1] == c && raw[i+2] == c {
					triple = true
					i += 2
				}
			case '[':
				square++
			case ']':
				square--
			case '{':
				curly++
			case '}':
				curly--
			}
			if c != ' ' && c != '\t' && c != '\r' && c != '\n' {
				end = i + 1
			}
		}
		if square < 0 || curly < 0 {
			return nil, fmt.Errorf("unbalanced TOML at %d", i)
		}
		if c == '\n' && square == 0 && curly == 0 && quote == 0 {
			statements = append(statements, installTOMLStatement{start: start, end: i + 1, valueEnd: end, text: strings.TrimSpace(raw[start:end])})
			start = i + 1
			end = start
		}
	}
	if quote != 0 || square != 0 || curly != 0 {
		return nil, fmt.Errorf("unterminated TOML value")
	}
	if start < len(raw) {
		statements = append(statements, installTOMLStatement{start: start, end: len(raw), valueEnd: end, text: strings.TrimSpace(raw[start:end])})
	}
	return statements, nil
}

var installCodexHeader = regexp.MustCompile(`^\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:browser-bridge|"browser-bridge"|'browser-bridge')\s*(\.[^\]]+)?\]$`)
var installCodexAssignment = regexp.MustCompile(`^(?:command|"command"|'command'|args|"args"|'args')\s*=`)

type installTextEdit struct {
	start, end int
	value      string
}

func installApplyEdits(raw string, edits []installTextEdit) string {
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].start > edits[j].start })
	for _, edit := range edits {
		raw = raw[:edit.start] + edit.value + raw[edit.end:]
	}
	return raw
}

func installUpdateCodex(raw string, remove bool) (string, error) {
	statements, err := installTOMLStatements(raw)
	if err != nil {
		return "", err
	}
	edits := []installTextEdit{}
	inOwned, inMain, found := false, false, false
	seen := map[string]bool{}
	insertAt := len(raw)
	for _, statement := range statements {
		text := statement.text
		if strings.HasPrefix(text, "[") {
			if inMain {
				insertAt = statement.start
			}
			match := installCodexHeader.FindStringSubmatch(text)
			inOwned = match != nil
			inMain = inOwned && match[1] == ""
			if inMain {
				if found {
					return "", fmt.Errorf("duplicate Browser Bridge TOML table")
				}
				found = true
			}
		}
		if remove && inOwned && text != "" {
			edits = append(edits, installTextEdit{statement.start, statement.valueEnd, ""})
			continue
		}
		if !remove && inMain && installCodexAssignment.MatchString(text) {
			equals := strings.Index(raw[statement.start:statement.valueEnd], "=") + statement.start
			key := strings.Trim(strings.TrimSpace(raw[statement.start:equals]), "\"'")
			if seen[key] {
				return "", fmt.Errorf("duplicate %s in Browser Bridge TOML table", key)
			}
			seen[key] = true
			start := equals + 1
			for start < statement.valueEnd && (raw[start] == ' ' || raw[start] == '\t') {
				start++
			}
			replacement := `"bbx"`
			if key == "args" {
				replacement = `["mcp", "serve"]`
			}
			edits = append(edits, installTextEdit{start, statement.valueEnd, replacement})
		}
	}
	if remove {
		return installApplyEdits(raw, edits), nil
	}
	addition := ""
	if !found {
		addition = "\n[mcp_servers.\"browser-bridge\"]\n"
	}
	if !seen["command"] {
		addition += "command = \"bbx\"\n"
	}
	if !seen["args"] {
		addition += "args = [\"mcp\", \"serve\"]\n"
	}
	if addition != "" {
		if insertAt > 0 && raw[insertAt-1] != '\n' {
			addition = "\n" + addition
		}
		edits = append(edits, installTextEdit{insertAt, insertAt, addition})
	}
	return installApplyEdits(raw, edits), nil
}

func installMCPConfigured(raw, client, path string, scope installScope) bool {
	if client == "codex" {
		statements, err := installTOMLStatements(raw)
		if err != nil {
			return false
		}
		for _, statement := range statements {
			match := installCodexHeader.FindStringSubmatch(statement.text)
			if match != nil && match[1] == "" {
				return true
			}
		}
		return false
	}
	root, err := installParseJSON(raw)
	return err == nil && installJSONLookup(root, installMCPKey(client, path, scope), "browser-bridge") != nil
}

func installAgentMCP(client string, scope installScope, remove bool) ([]string, error) {
	if !installContains(installAgentNames, client) {
		return nil, fmt.Errorf("unsupported MCP client %q", client)
	}
	paths := []string{}
	for _, path := range installMCPPaths(client, scope) {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			if remove {
				continue
			}
			data = []byte("{}\n")
			if client == "codex" {
				data = nil
			}
		} else if err != nil {
			return paths, err
		}
		raw := string(data)
		var updated string
		if client == "codex" {
			updated, err = installUpdateCodex(raw, remove)
		} else {
			updated, err = installUpdateJSONConfig(raw, client, path, scope, remove)
		}
		if err != nil {
			return paths, fmt.Errorf("cannot update %s: %w", path, err)
		}
		if remove && updated == raw {
			continue
		}
		if err := installAtomicWrite(path, []byte(updated), 0600); err != nil {
			return paths, err
		}
		paths = append(paths, path)
	}
	return paths, nil
}

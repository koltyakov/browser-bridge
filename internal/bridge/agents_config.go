package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strings"
)

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
	agent := installAgentByKey(client)
	if agent == nil || !installMCPSupported(client, scope) {
		return nil
	}
	return agent.mcp.paths(scope)
}

func installMCPKey(client, path string, scope installScope) string {
	agent := installAgentByKey(client)
	if agent == nil {
		return ""
	}
	if agent.mcp.keyForPath != nil {
		return agent.mcp.keyForPath(path, scope)
	}
	return agent.mcp.key
}

func installMCPEntry(client string) object {
	entry := object{}
	if agent := installAgentByKey(client); agent != nil {
		for key, val := range agent.mcp.entry {
			entry[key] = append([]byte(nil), val...)
		}
	}
	return entry
}

func installUpdateJSONConfig(raw, client, path string, scope installScope, remove bool) (string, error) {
	root, err := installParseJSON(raw)
	if err != nil {
		return "", err
	}
	agent := installAgentByKey(client)
	if agent == nil {
		return "", fmt.Errorf("unsupported MCP client %q", client)
	}
	if agent.mcp.schemaVersion != 0 && !remove {
		version := fmt.Sprint(agent.mcp.schemaVersion)
		if schema := installJSONLookup(root, "schema_version"); schema == nil {
			raw, err = installJSONEdit(raw, []string{"schema_version"}, &version)
			if err != nil {
				return "", err
			}
			root, err = installParseJSON(raw)
			if err != nil {
				return "", err
			}
		} else if strings.TrimSpace(raw[schema.start:schema.end]) != version {
			return "", fmt.Errorf("%s requires schema_version %s; refusing to change an unsupported settings schema", agent.label, version)
		}
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
	// Cline's CLI writes a nested transport; update it in place rather than
	// adding a competing flat command. Never silently convert a remote server.
	if agent.mcp.transport != installTransportLegacy {
		var err error
		keys, err = installStdioEntryKeys(raw, existing, client, keys)
		if err != nil {
			return "", err
		}
	}
	// Preserve environment variables, disabled flags and custom timeouts.
	settings := installJSONLookup(root, keys...)
	fields := []string{"type", "transport", "command", "args", "env"}
	for _, field := range fields {
		v, exists := entry[field]
		if !exists {
			continue
		}
		if field == "env" && installJSONLookup(settings, field) != nil {
			continue
		}
		replacement := string(v)
		raw, err = installJSONEdit(raw, append(append([]string{}, keys...), field), &replacement)
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
	agent := installAgentByKey(client)
	if agent == nil {
		return false
	}
	if agent.mcp.format == installConfigYAML {
		return installGooseMCPConfigured(raw)
	}
	if agent.mcp.format == installConfigTOML {
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

// installMCPStale reports a configured entry whose command or arguments name
// an absolute path that no longer exists, such as a launcher left behind by a
// removed checkout. Clients fail to start such servers without telling the
// user why, so presence alone does not prove a working configuration.
func installMCPStale(raw, client, path string, scope installScope) bool {
	return len(installMCPMissingPaths(raw, client, path, scope)) > 0
}

// installMCPRepairable reports a stale entry that Browser Bridge itself wrote.
// v1 on Windows launched node with the package's packages/mcp-server/src/bin.js,
// which v2 no longer ships. Other missing paths may be the user's own wrapper,
// so those are reported by doctor rather than rewritten.
func installMCPRepairable(raw, client, path string, scope installScope) bool {
	return slices.ContainsFunc(installMCPMissingPaths(raw, client, path, scope), installLegacyLauncher)
}

func installLegacyLauncher(path string) bool {
	slashed := strings.ToLower(strings.ReplaceAll(path, `\`, "/"))
	if strings.HasSuffix(slashed, "/packages/mcp-server/src/bin.js") {
		return true
	}
	base := slashed[strings.LastIndex(slashed, "/")+1:]
	for _, name := range []string{"bbx", "bbx-mcp"} {
		for _, extension := range []string{"", ".exe", ".cmd", ".ps1", ".js"} {
			if base == name+extension {
				return true
			}
		}
	}
	return false
}

func installMCPMissingPaths(raw, client, path string, scope installScope) []string {
	missing := []string{}
	for _, text := range installMCPLaunchStrings(raw, client, path, scope) {
		if filepath.IsAbs(text) {
			if _, err := os.Stat(text); errors.Is(err, os.ErrNotExist) {
				missing = append(missing, text)
			}
		}
	}
	return missing
}

// installMCPLaunchStrings returns the browser-bridge entry's command and
// argument strings. Unparseable values are skipped, so detection stays
// conservative for hand-edited configurations.
func installMCPLaunchStrings(raw, client, path string, scope installScope) []string {
	agent := installAgentByKey(client)
	if agent == nil || agent.mcp.format == installConfigYAML {
		return nil
	}
	if agent.mcp.format == installConfigTOML {
		return installCodexLaunchStrings(raw)
	}
	root, err := installParseJSON(raw)
	if err != nil {
		return nil
	}
	entry := installJSONLookup(root, installMCPKey(client, path, scope), "browser-bridge")
	if entry == nil || entry.kind != '{' {
		return nil
	}
	scopes := []*installJSONNode{entry}
	if nested := installJSONLookup(entry, "transport"); nested != nil && nested.kind == '{' {
		scopes = append(scopes, nested)
	}
	out := []string{}
	for _, node := range scopes {
		for _, field := range []string{"command", "args"} {
			out = append(out, installJSONStrings(raw, installJSONLookup(node, field))...)
		}
	}
	return out
}

// v1 wrote Codex values with JSON.stringify, which is also valid TOML.
func installCodexLaunchStrings(raw string) []string {
	statements, err := installTOMLStatements(raw)
	if err != nil {
		return nil
	}
	out := []string{}
	inMain := false
	for _, statement := range statements {
		if strings.HasPrefix(statement.text, "[") {
			match := installCodexHeader.FindStringSubmatch(statement.text)
			inMain = match != nil && match[1] == ""
			continue
		}
		if !inMain || !installCodexAssignment.MatchString(statement.text) {
			continue
		}
		equals := strings.Index(raw[statement.start:statement.valueEnd], "=") + statement.start
		text := strings.TrimSpace(raw[equals+1 : statement.valueEnd])
		var one string
		var many []string
		if json.Unmarshal([]byte(text), &one) == nil {
			out = append(out, one)
		} else if json.Unmarshal([]byte(text), &many) == nil {
			out = append(out, many...)
		}
	}
	return out
}

// installNonNil keeps empty lists as [] rather than null in JSON evidence.
func installNonNil(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// installRepairStaleMCP rewrites global Browser Bridge MCP entries that still
// launch a removed v1 entrypoint, keeping their env, disabled flags, and
// timeouts. Upgrades run it so existing clients keep working without a manual
// `bbx install-mcp`. Files owned by another account are left alone: a
// rename-based write from an elevated install would take over the user's
// config. Failures are returned for reporting and never stop installation.
func installRepairStaleMCP(ctx context.Context) (repaired, failed []string) {
	scope, err := installCurrentScope()
	if err != nil {
		return nil, []string{err.Error()}
	}
	for _, target := range installAgentNames {
		if !installMCPSupported(target, scope) {
			continue
		}
		for _, path := range installMCPPaths(target, scope) {
			if ctx.Err() != nil {
				return repaired, failed
			}
			data, err := os.ReadFile(path)
			if err != nil || !installMCPConfigured(string(data), target, path, scope) || !installMCPRepairable(string(data), target, path, scope) {
				continue
			}
			if !installOwnedByCurrentUser(path) {
				failed = append(failed, fmt.Sprintf("%s MCP config %s belongs to another user; run `bbx install-mcp %s` as its owner.", installAgentLabels[target], path, target))
				continue
			}
			if _, err := installWriteMCPConfig(target, path, scope, false); err != nil {
				failed = append(failed, fmt.Sprintf("%s MCP config %s could not be repaired (%v); run `bbx install-mcp %s`.", installAgentLabels[target], path, err, target))
				continue
			}
			repaired = append(repaired, path)
		}
	}
	return repaired, failed
}

// installJSONStrings decodes a string node or the string members of an array.
func installJSONStrings(raw string, node *installJSONNode) []string {
	if node == nil {
		return nil
	}
	nodes := []*installJSONNode{node}
	if node.kind == '[' {
		nodes = nodes[:0]
		for _, member := range node.members {
			nodes = append(nodes, member.value)
		}
	}
	out := []string{}
	for _, n := range nodes {
		var text string
		if n != nil && n.kind == '"' && json.Unmarshal([]byte(raw[n.start:n.end]), &text) == nil {
			out = append(out, text)
		}
	}
	return out
}

func installAgentMCP(client string, scope installScope, remove bool) ([]string, error) {
	agent := installAgentByKey(client)
	if agent == nil {
		return nil, fmt.Errorf("unsupported MCP client %q", client)
	}
	if !remove || !installMCPSupported(client, scope) {
		if err := installValidateMCPScope(client, scope); err != nil {
			return nil, err
		}
	}
	paths := []string{}
	candidates := installMCPPaths(client, scope)
	if remove && agent.mcp.removePaths != nil {
		candidates = agent.mcp.removePaths(scope)
	}
	for _, path := range candidates {
		changed, err := installWriteMCPConfig(client, path, scope, remove)
		if err != nil {
			return paths, fmt.Errorf("cannot update %s: %w", path, err)
		}
		if changed {
			paths = append(paths, path)
		}
	}
	return paths, nil
}

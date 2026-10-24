package bridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestAdditionalAgentPathsAndScope(t *testing.T) {
	_, scope := installTestScope(t)
	userMCP := map[string]string{
		"gemini": filepath.Join(scope.home, ".gemini", "settings.json"),
		"cline":  filepath.Join(scope.home, ".cline", "data", "settings", "cline_mcp_settings.json"),
		"zed":    filepath.Join(installZedHome(scope), "settings.json"),
		"amp":    filepath.Join(scope.home, ".config", "amp", "settings.json"),
		"droid":  filepath.Join(scope.home, ".factory", "mcp.json"),
	}
	userSkills := map[string]string{"gemini": ".gemini/skills", "cline": ".cline/skills", "zed": ".agents/skills", "amp": ".config/amp/skills", "droid": ".factory/skills"}
	for _, target := range []string{"gemini", "cline", "zed", "amp", "droid"} {
		if got := installMCPPath(target, scope); got != userMCP[target] {
			t.Fatalf("%s user MCP: %s", target, got)
		}
		if got := installSkillBase(target, scope); got != filepath.Join(scope.home, filepath.FromSlash(userSkills[target])) {
			t.Fatalf("%s user skills: %s", target, got)
		}
	}
	scope.global = false
	projectMCP := map[string]string{"gemini": ".gemini/settings.json", "zed": ".zed/settings.json", "amp": ".amp/settings.json", "droid": ".factory/mcp.json"}
	for target, path := range projectMCP {
		if got := installMCPPath(target, scope); got != filepath.Join(scope.project, filepath.FromSlash(path)) {
			t.Fatalf("%s project MCP: %s", target, got)
		}
	}
	if installMCPPath("cline", scope) != "" || len(installMCPPaths("cline", scope)) != 0 {
		t.Fatal("Cline must not advertise native project MCP")
	}
	if _, err := installAgentMCP("cline", scope, false); err == nil || !strings.Contains(err.Error(), "--global") {
		t.Fatalf("missing unsupported-scope guidance: %v", err)
	}
	if installMCPPath("unknown", scope) != "" || installSkillBase("unknown", scope) != "" {
		t.Fatal("unknown targets resolved to a directory")
	}
	_, targets, err := installParseAgentArgs([]string{"all", "--project", scope.project}, false)
	if err != nil || len(targets) != len(installAgentNames)-4 || installContains(targets, "cline") {
		t.Fatalf("project all must omit unsupported user-only MCP: %v %v", targets, err)
	}
	if _, _, err := installParseAgentArgs([]string{"gemini,cline", "--project", scope.project}, false); err == nil {
		t.Fatal("explicit mixed-scope request must fail before any writes")
	}
	if installExists(scope.project) {
		t.Fatal("scope validation wrote project files")
	}
}

func TestAdditionalAgentOverrides(t *testing.T) {
	_, scope := installTestScope(t)
	custom := filepath.Join(scope.home, "custom")
	t.Setenv("GEMINI_CLI_HOME", custom)
	if got := installMCPPath("gemini", scope); got != filepath.Join(custom, ".gemini", "settings.json") {
		t.Fatal(got)
	}
	if got := installSkillBase("gemini", scope); got != filepath.Join(custom, ".gemini", "skills") {
		t.Fatal(got)
	}
	t.Setenv("CLINE_DIR", filepath.Join(custom, "cline-root"))
	if got := installMCPPath("cline", scope); got != filepath.Join(custom, "cline-root", "data", "settings", "cline_mcp_settings.json") {
		t.Fatal(got)
	}
	if got := installSkillBase("cline", scope); got != filepath.Join(custom, "cline-root", "skills") {
		t.Fatal(got)
	}
	t.Setenv("CLINE_DATA_DIR", filepath.Join(custom, "cline-data"))
	if got := installMCPPath("cline", scope); got != filepath.Join(custom, "cline-data", "settings", "cline_mcp_settings.json") {
		t.Fatal(got)
	}
	t.Setenv("CLINE_MCP_SETTINGS_PATH", filepath.Join(custom, "selected.json"))
	if got := installMCPPath("cline", scope); got != filepath.Join(custom, "selected.json") {
		t.Fatal(got)
	}
	switch runtime.GOOS {
	case "linux":
		t.Setenv("XDG_CONFIG_HOME", filepath.Join(custom, "xdg"))
		if got := installZedHome(scope); got != filepath.Join(custom, "xdg", "zed") {
			t.Fatal(got)
		}
		t.Setenv("FLATPAK_XDG_CONFIG_HOME", filepath.Join(custom, "flatpak"))
		if got := installZedHome(scope); got != filepath.Join(custom, "flatpak", "zed") {
			t.Fatal(got)
		}
	case "darwin":
		t.Setenv("XDG_CONFIG_HOME", filepath.Join(custom, "xdg"))
		if got := installZedHome(scope); got != filepath.Join(scope.home, ".config", "zed") {
			t.Fatal("macOS Zed must not inherit Linux XDG behavior", got)
		}
	}
	scope.global = false
	if got := installMCPPath("gemini", scope); got != filepath.Join(scope.project, ".gemini", "settings.json") {
		t.Fatal("home overrides leaked into project scope", got)
	}
}

func TestAdditionalAgentConfigPreservation(t *testing.T) {
	_, scope := installTestScope(t)
	for _, target := range []string{"gemini", "cline", "zed", "amp", "droid"} {
		t.Run(target, func(t *testing.T) {
			path := installMCPPath(target, scope)
			key := installMCPKey(target, path, scope)
			raw := "// config\n{\n  \"" + key + "\": {\n    \"other\": {\"command\":\"leave-alone\"},\n    \"browser-bridge\": {\"command\":\"old\",\"args\":[],\"env\":{\"PRIVATE\":\"preserve\"},\"disabled\":true,\"trust\":false,\"timeout\":123},\n  },\n  \"theme\":\"dark\",\n}\n"
			installTestWrite(t, path, raw)
			if _, err := installAgentMCP(target, scope, false); err != nil {
				t.Fatal(err)
			}
			updated, _ := os.ReadFile(path)
			for _, keep := range []string{"// config", `"PRIVATE":"preserve"`, `"disabled":true`, `"trust":false`, `"timeout":123`, `"theme":"dark"`, `"command":"leave-alone"`} {
				if !strings.Contains(string(updated), keep) {
					t.Fatalf("lost %s in %s", keep, updated)
				}
			}
			root, err := installParseJSON(string(updated))
			if err != nil {
				t.Fatal(err)
			}
			command := installJSONLookup(root, key, "browser-bridge", "command")
			if command == nil || string(updated[command.start:command.end]) != `"bbx"` {
				t.Fatal(string(updated))
			}
			if target == "amp" && installJSONLookup(root, "amp") != nil {
				t.Fatal("Amp key must be literal, not a nested amp object")
			}
			if _, err := installAgentMCP(target, scope, false); err != nil {
				t.Fatal(err)
			}
			again, _ := os.ReadFile(path)
			if string(again) != string(updated) {
				t.Fatal("not idempotent")
			}
			if _, err := installAgentMCP(target, scope, true); err != nil {
				t.Fatal(err)
			}
			removed, _ := os.ReadFile(path)
			if installMCPConfigured(string(removed), target, path, scope) || !strings.Contains(string(removed), "leave-alone") {
				t.Fatal(string(removed))
			}
		})
	}
}

func TestClineNestedTransportAndRemoteConflicts(t *testing.T) {
	_, scope := installTestScope(t)
	path := installMCPPath("cline", scope)
	raw := `{"mcpServers":{"browser-bridge":{"transport":{"type":"stdio","command":"old","args":[],"env":{"KEEP":"value"}},"disabled":true}}}`
	installTestWrite(t, path, raw)
	if _, err := installAgentMCP("cline", scope, false); err != nil {
		t.Fatal(err)
	}
	updated, _ := os.ReadFile(path)
	root, _ := installParseJSON(string(updated))
	if installJSONLookup(root, "mcpServers", "browser-bridge", "command") != nil || !strings.Contains(string(updated), `"KEEP":"value"`) || !strings.Contains(string(updated), `"disabled":true`) {
		t.Fatal(string(updated))
	}
	command := installJSONLookup(root, "mcpServers", "browser-bridge", "transport", "command")
	if command == nil || string(updated[command.start:command.end]) != `"bbx"` {
		t.Fatal(string(updated))
	}
	for _, target := range []string{"gemini", "cline", "zed", "amp", "droid"} {
		path := installMCPPath(target, scope)
		key := installMCPKey(target, path, scope)
		for _, transport := range []string{`{"url":"https://example.com/mcp"}`, `{"type":"http"}`, `{"transport":{"type":"sse","url":"https://example.com"}}`, `{"command":{"path":"bbx","args":["mcp","serve"]}}`, `{"command":"bbx","transport":{"type":"stdio","command":"bbx"}}`} {
			original := `{"` + key + `":{"browser-bridge":` + transport + `}}`
			installTestWrite(t, path, original)
			if _, err := installAgentMCP(target, scope, false); err == nil {
				t.Fatalf("accepted %s remote transport: %s", target, transport)
			}
			data, _ := os.ReadFile(path)
			if string(data) != original {
				t.Fatal("modified conflicting transport")
			}
			if _, err := installAgentMCP(target, scope, true); err != nil {
				t.Fatal("explicit removal must work for conflicting transports", err)
			}
		}
	}
}

func TestAmpExistingJSONCAndAmbiguousFiles(t *testing.T) {
	_, scope := installTestScope(t)
	for _, global := range []bool{true, false} {
		scope.global = global
		path := installMCPPath("amp", scope)
		installTestWrite(t, path+"c", "// existing jsonc\n{}\n")
		paths, err := installAgentMCP("amp", scope, false)
		if err != nil || len(paths) != 1 || paths[0] != path+"c" || installExists(path) {
			t.Fatalf("failed existing JSONC selection: %v %v", paths, err)
		}
		installTestWrite(t, path, "{}")
		if _, err := installAgentMCP("amp", scope, false); err == nil {
			t.Fatal("silently selected one of two ambiguous settings files")
		}
		if _, err := installAgentMCP("amp", scope, true); err != nil {
			t.Fatal("uninstall must not be blocked by unrelated coexistence", err)
		}
		for _, candidate := range []string{path, path + "c"} {
			data, err := os.ReadFile(candidate)
			if err != nil || installMCPConfigured(string(data), "amp", candidate, scope) {
				t.Fatalf("uninstall must preserve both files without our entry: %s %v", candidate, err)
			}
		}
	}
}

func TestClineConcurrentConfigWrites(t *testing.T) {
	_, scope := installTestScope(t)
	path := installMCPPath("cline", scope)
	installTestWrite(t, path, `{"mcpServers":{"other":{"command":"preserve"}},"theme":"dark"}`)
	var writers sync.WaitGroup
	errors := make(chan error, 4)
	for i := 0; i < cap(errors); i++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			_, err := installAgentMCP("cline", scope, false)
			errors <- err
		}()
	}
	writers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := os.ReadFile(path)
	if !installMCPConfigured(string(raw), "cline", path, scope) || !strings.Contains(string(raw), "preserve") || installExists(path+".lock") {
		t.Fatal(string(raw))
	}
}

func TestAdditionalSkillsAndSharedOwnership(t *testing.T) {
	_, scope := installTestScope(t)
	for _, global := range []bool{true, false} {
		scope.global = global
		targets := []string{"gemini", "cline", "zed", "amp", "droid", "agents"}
		paths, err := installAgentSkills(targets, scope)
		want := 5
		if !global {
			want = 4
		}
		if err != nil || len(paths) != want {
			t.Fatalf("shared skills weren't deduplicated: %v %v", paths, err)
		}
		for _, target := range targets {
			path := filepath.Join(installSkillBase(target, scope), "browser-bridge")
			metadata, managed, err := installReadSkillMetadata(path)
			if err != nil || !managed || !installContains(metadata.Targets, target) || !installExists(filepath.Join(path, "references", "protocol.md")) {
				t.Fatalf("incomplete %s skill: %v %v", target, metadata, err)
			}
		}
		shared := filepath.Join(installSkillBase("zed", scope), "browser-bridge")
		if _, err := installAgentSkill("zed", scope, true); err != nil || !installExists(filepath.Join(shared, "SKILL.md")) {
			t.Fatalf("removing Zed deleted another client's shared skill: %v", err)
		}
		if _, err := installAgentSkill("agents", scope, true); err != nil {
			t.Fatal(err)
		}
		if !global {
			if !installExists(filepath.Join(shared, "SKILL.md")) {
				t.Fatal("removing generic target deleted Amp's project skill")
			}
			if _, err := installAgentSkill("amp", scope, true); err != nil {
				t.Fatal(err)
			}
		}
		if installExists(shared) {
			t.Fatal("last shared owner did not remove the managed bundle")
		}
	}
}

func TestGenericSkillDoesNotInventZedInstallation(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	if _, err := installAgentSkill("agents", scope, false); err != nil {
		t.Fatal(err)
	}
	status := installCollectStatus(scope)
	var skills []object
	if err := json.Unmarshal(status["skillTargets"], &skills); err != nil {
		t.Fatal(err)
	}
	for _, entry := range skills {
		if entry.text("key") == "zed" && !installAgentDetected("zed", scope) && entry.boolean("installed") {
			t.Fatal("generic .agents bundle invented a Zed installation")
		}
	}
}

func TestAdditionalSkillRollbackIncludesSharedAliases(t *testing.T) {
	_, scope := installTestScope(t)
	blocked := filepath.Join(installSkillBase("droid", scope), "browser-bridge", "SKILL.md")
	installTestWrite(t, blocked, "user-owned")
	if _, err := installAgentSkills([]string{"zed", "agents", "droid"}, scope); err == nil {
		t.Fatal("expected unmanaged-skill refusal")
	}
	if installExists(filepath.Join(installSkillBase("zed", scope), "browser-bridge")) {
		t.Fatal("rollback left a new shared bundle behind")
	}
	if data, _ := os.ReadFile(blocked); string(data) != "user-owned" {
		t.Fatal("overwrote unmanaged bundle")
	}
}

func TestAdditionalSkillParentSymlinksAreDeduplicated(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation may require developer mode")
	}
	_, scope := installTestScope(t)
	shared := filepath.Join(scope.home, "shared-skills")
	if err := os.MkdirAll(shared, 0755); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{".gemini", ".agents"} {
		parent := filepath.Join(scope.home, root)
		if err := os.MkdirAll(parent, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(shared, filepath.Join(parent, "skills")); err != nil {
			t.Fatal(err)
		}
	}
	paths, err := installAgentSkills([]string{"gemini", "zed", "agents"}, scope)
	if err != nil || len(paths) != 1 {
		t.Fatalf("parent-symlink aliases weren't deduplicated: %v %v", paths, err)
	}
	metadata, managed, err := installReadSkillMetadata(filepath.Join(shared, "browser-bridge"))
	if err != nil || !managed || strings.Join(metadata.Targets, ",") != "gemini,zed,agents" {
		t.Fatalf("lost shared owners: %v %v", metadata, err)
	}
	if _, err := installAgentSkill("zed", scope, true); err != nil || !installExists(filepath.Join(shared, "browser-bridge", "SKILL.md")) {
		t.Fatal("shared-symlink removal damaged another owner", err)
	}
}

func TestAdditionalSetupInstallAndStatus(t *testing.T) {
	c, _ := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	targets := []string{"gemini", "cline", "zed", "amp", "droid", "pi", "kilo", "qwen", "goose", "openhands", "muse", "grok"}
	for _, target := range targets {
		for _, kind := range []string{"mcp", "skill"} {
			result, err := setupInstall(c, object{"kind": value(kind), "target": value(target)})
			if err != nil || result.text("target") != target || result.text("action") != "install" {
				t.Fatalf("setup.install %s/%s: %v %v", target, kind, result, err)
			}
		}
	}
	status, err := setupStatus(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"mcpClients", "skillTargets"} {
		var entries []object
		if err := json.Unmarshal(status[kind], &entries); err != nil {
			t.Fatal(err)
		}
		for _, target := range targets {
			found := false
			for _, entry := range entries {
				if entry.text("key") == target {
					found = true
					field := "installed"
					if kind == "mcpClients" {
						field = "configured"
					}
					if !entry.boolean(field) || entry.text("label") != installAgentLabels[target] {
						t.Fatalf("setup status doesn't reflect %s/%s: %v", target, kind, entry)
					}
				}
			}
			if !found {
				t.Fatalf("missing %s status", target)
			}
		}
	}
	for _, target := range targets {
		for _, kind := range []string{"mcp", "skill"} {
			if _, err := setupInstall(c, object{"kind": value(kind), "target": value(target), "action": value("uninstall")}); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestLegacySharedSkillOwnershipSurvivesAliases(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows symlink creation may require developer mode")
	}
	_, scope := installTestScope(t)
	if _, err := installAgentSkill("agents", scope, false); err != nil {
		t.Fatal(err)
	}
	shared := filepath.Join(installSkillBase("agents", scope), "browser-bridge")
	metadata, _, err := installReadSkillMetadata(shared)
	if err != nil {
		t.Fatal(err)
	}
	metadata.Targets = nil // Model a pre-ownership managed bundle.
	if err := installWriteSkillMetadata(shared, metadata); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(scope.home, ".gemini"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(installSkillBase("agents", scope), installSkillBase("gemini", scope)); err != nil {
		t.Fatal(err)
	}
	if _, err := installAgentSkill("gemini", scope, false); err != nil {
		t.Fatal(err)
	}
	metadata, _, _ = installReadSkillMetadata(shared)
	if strings.Join(metadata.Targets, ",") != "agents,gemini" {
		t.Fatal("adopting a legacy symlink alias lost generic ownership", metadata.Targets)
	}
	if _, err := installAgentSkill("gemini", scope, true); err != nil || !installExists(filepath.Join(shared, "SKILL.md")) {
		t.Fatal("alias removal deleted legacy generic skill", err)
	}
}

func TestMCPStaleDetectsMissingLauncherPaths(t *testing.T) {
	_, scope := installTestScope(t)
	path := filepath.Join(scope.home, ".claude.json")
	key := installMCPKey("claude", path, scope)
	live, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(scope.home, "removed", "packages", "mcp-server", "src", "bin.js")
	entry := func(command string, args ...string) string {
		raw, _ := json.Marshal(map[string]any{key: map[string]any{"browser-bridge": map[string]any{"type": "stdio", "command": command, "args": args}}})
		return string(raw)
	}
	for name, test := range map[string]struct {
		raw   string
		stale bool
	}{
		"bare command":    {entry("bbx", "mcp", "serve"), false},
		"existing binary": {entry(live, "mcp", "serve"), false},
		"missing command": {entry(missing), true},
		"missing script":  {entry(live, missing), true},
		"other server":    {`{"` + key + `":{"other":{"command":"` + missing + `"}}}`, false},
	} {
		if got := installMCPStale(test.raw, "claude", path, scope); got != test.stale {
			t.Errorf("%s: stale = %v, want %v", name, got, test.stale)
		}
	}
	clinePath := filepath.Join(scope.home, ".cline", "data", "settings", "cline_mcp_settings.json")
	nested, _ := json.Marshal(map[string]any{installMCPKey("cline", clinePath, scope): map[string]any{"browser-bridge": map[string]any{"transport": map[string]any{"type": "stdio", "command": "bbx", "args": []string{missing}}}}})
	if !installMCPStale(string(nested), "cline", clinePath, scope) {
		t.Error("nested transport args should be checked")
	}
}

func TestRepairStaleMCPMigratesV1Launchers(t *testing.T) {
	_, scope := installTestScope(t)
	node, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// v1 on Windows launched node with the package's MCP script, which v2 removed.
	legacy := filepath.Join(scope.home, "npm", "node_modules", "@browserbridge", "bbx", "packages", "mcp-server", "src", "bin.js")
	quoted := func(s string) string { raw, _ := json.Marshal(s); return string(raw) }
	claude := installMCPPath("claude", scope)
	installTestWrite(t, claude, `{"mcpServers":{"browser-bridge":{"type":"stdio","command":`+quoted(node)+`,"args":[`+quoted(legacy)+`],"env":{"KEEP":"1"}},"other":{"command":"x"}}}`)
	opencode := installMCPPath("opencode", scope)
	installTestWrite(t, opencode, `{"mcp":{"browser-bridge":{"type":"local","command":[`+quoted(node)+`,`+quoted(legacy)+`]}}}`)
	codex := installMCPPath("codex", scope)
	installTestWrite(t, codex, "model = \"x\"\n\n[mcp_servers.browser-bridge]\ncommand = "+quoted(node)+"\nargs = ["+quoted(legacy)+"]\n")
	// A missing user wrapper is reported by doctor but not rewritten.
	custom := filepath.Join(scope.home, "bin", "my-wrapper.sh")
	cursor := installMCPPath("cursor", scope)
	installTestWrite(t, cursor, `{"mcpServers":{"browser-bridge":{"command":`+quoted(custom)+`}}}`)
	healthy := installMCPPath("copilot", scope)
	installTestWrite(t, healthy, `{"servers":{"browser-bridge":{"type":"stdio","command":"bbx","args":["mcp","serve"]}}}`)
	before, _ := os.ReadFile(healthy)

	if !installMCPStale(mustRead(t, codex), "codex", codex, scope) {
		t.Fatal("Codex TOML launchers should be checked")
	}
	repaired, failed := installRepairStaleMCP(context.Background())
	if len(failed) != 0 {
		t.Fatalf("unexpected failures: %v", failed)
	}
	if !installContains(repaired, claude) || !installContains(repaired, opencode) || !installContains(repaired, codex) || len(repaired) != 3 {
		t.Fatalf("repaired %v", repaired)
	}
	for target, path := range map[string]string{"claude": claude, "opencode": opencode, "codex": codex} {
		raw := mustRead(t, path)
		if installMCPStale(raw, target, path, scope) || !strings.Contains(raw, "bbx") || strings.Contains(raw, "bin.js") {
			t.Errorf("%s not repaired: %s", target, raw)
		}
	}
	if raw := mustRead(t, claude); !strings.Contains(raw, `"KEEP":"1"`) || !strings.Contains(raw, `"other":{"command":"x"}`) {
		t.Errorf("repair should keep env and other servers: %s", raw)
	}
	if !strings.HasPrefix(mustRead(t, codex), "model = \"x\"") {
		t.Errorf("repair should keep unrelated Codex settings: %s", mustRead(t, codex))
	}
	if !strings.Contains(mustRead(t, cursor), "my-wrapper.sh") {
		t.Error("an unrecognized missing launcher must not be rewritten")
	}
	if after, _ := os.ReadFile(healthy); string(after) != string(before) {
		t.Error("a working entry must not be rewritten")
	}
	if repaired, _ := installRepairStaleMCP(context.Background()); len(repaired) != 0 {
		t.Fatalf("repair should be idempotent, got %v", repaired)
	}
}

func TestLegacyLauncherRecognition(t *testing.T) {
	for path, want := range map[string]bool{
		"/usr/lib/node_modules/@browserbridge/bbx/packages/mcp-server/src/bin.js": true,
		`C:\Users\a\AppData\Roaming\npm\bbx-mcp.cmd`:                              true,
		"/usr/local/bin/bbx":                         true,
		"/opt/tools/bbx-wrapper.sh":                  false,
		"/home/a/project/packages/server/src/bin.js": false,
	} {
		if got := installLegacyLauncher(path); got != want {
			t.Errorf("%s: %v, want %v", path, got, want)
		}
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

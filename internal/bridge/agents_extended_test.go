package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExtendedAgentPathsAndOverrides(t *testing.T) {
	_, scope := installTestScope(t)
	for target, suffix := range map[string]string{
		"pi": ".pi/agent/mcp.json", "kilo": ".config/kilo/kilo.jsonc", "qwen": ".qwen/settings.json",
		"openhands": ".openhands/mcp.json", "muse": ".config/muse/settings.json", "grok": ".grok/config.toml",
	} {
		if got := installMCPPath(target, scope); got != filepath.Join(scope.home, filepath.FromSlash(suffix)) {
			t.Fatalf("%s: %s", target, got)
		}
	}
	for _, test := range []struct{ target, env, suffix string }{
		{"pi", "PI_CODING_AGENT_DIR", "mcp.json"}, {"qwen", "QWEN_HOME", "settings.json"},
		{"grok", "GROK_HOME", "config.toml"}, {"openhands", "OPENHANDS_PERSISTENCE_DIR", "mcp.json"},
	} {
		dir := filepath.Join(scope.home, test.target+"-custom")
		t.Setenv(test.env, dir)
		if got := installMCPPath(test.target, scope); got != filepath.Join(dir, test.suffix) {
			t.Fatalf("%s override: %s", test.target, got)
		}
		if test.target != "openhands" && installSkillBase(test.target, scope) != filepath.Join(dir, "skills") {
			t.Fatal("skill did not follow home override", test.target)
		}
	}
	t.Setenv("PI_CODING_AGENT_DIR", "~/custom-pi")
	if got := installMCPPath("pi", scope); got != filepath.Join(scope.home, "custom-pi", "mcp.json") {
		t.Fatal(got)
	}
	root := filepath.Join(scope.home, "goose-root")
	t.Setenv("GOOSE_PATH_ROOT", root)
	if installMCPPath("goose", scope) != filepath.Join(root, "config", "config.yaml") || installSkillBase("goose", scope) != filepath.Join(root, ".agents", "skills") {
		t.Fatal("Goose root must affect config and shared skills")
	}
	t.Setenv("GOOSE_PATH_ROOT", "relative-ignored")
	if strings.Contains(installMCPPath("goose", scope), "relative-ignored") {
		t.Fatal("Goose ignores relative GOOSE_PATH_ROOT")
	}
	xdg := filepath.Join(scope.home, "xdg")
	t.Setenv("XDG_CONFIG_HOME", xdg)
	if installMCPPath("muse", scope) != filepath.Join(xdg, "muse", "settings.json") || installSkillBase("muse", scope) != filepath.Join(xdg, "muse", "skills") {
		t.Fatal("Muse config/skills must follow XDG_CONFIG_HOME")
	}
	scope.global = false
	for target, suffix := range map[string]string{"pi": ".pi/mcp.json", "kilo": ".kilo/kilo.jsonc", "qwen": ".qwen/settings.json", "grok": ".grok/config.toml"} {
		if got := installMCPPath(target, scope); got != filepath.Join(scope.project, filepath.FromSlash(suffix)) {
			t.Fatalf("project %s inherited user override: %s", target, got)
		}
	}
	for _, target := range []string{"goose", "openhands", "muse"} {
		if installMCPPath(target, scope) != "" {
			t.Fatal("invented project MCP", target)
		}
		if _, err := installAgentMCP(target, scope, false); err == nil {
			t.Fatal("accepted unsupported project MCP", target)
		}
		if installSkillBase(target, scope) != filepath.Join(scope.project, ".agents", "skills") {
			t.Fatal("project skill unsupported", target)
		}
	}
}

func TestExtendedJSONPreservationAndConflicts(t *testing.T) {
	_, scope := installTestScope(t)
	for _, target := range []string{"pi", "kilo", "qwen", "openhands", "muse"} {
		t.Run(target, func(t *testing.T) {
			path := installMCPPath(target, scope)
			key := installMCPKey(target, path, scope)
			fields := `"command":"old","args":[],"env":{"KEEP":"secret"}`
			if target == "kilo" {
				fields = `"type":"local","command":["old"],"environment":{"KEEP":"secret"}`
			}
			if target == "muse" {
				fields += `,"transport":"stdio","mode":"required"`
			}
			raw := "// keep comment\n{\"" + key + `":{"other":{"command":"preserve"},"browser-bridge":{` + fields + `,"enabled":false,"disabled":true,"timeout":123}},"permissions":{"approval":"ask"}}`
			installTestWrite(t, path, raw)
			if _, err := installAgentMCP(target, scope, false); err != nil {
				t.Fatal(err)
			}
			updated, _ := os.ReadFile(path)
			for _, keep := range []string{"// keep comment", `"KEEP":"secret"`, `"enabled":false`, `"disabled":true`, `"timeout":123`, `"approval":"ask"`, `"command":"preserve"`} {
				if !strings.Contains(string(updated), keep) {
					t.Fatalf("lost %s: %s", keep, updated)
				}
			}
			root, _ := installParseJSON(string(updated))
			if target == "muse" && (installJSONLookup(root, "schema_version") == nil || !strings.Contains(string(updated), `"mode":"required"`)) {
				t.Fatal("Muse schema or mode changed", string(updated))
			}
			if _, err := installAgentMCP(target, scope, false); err != nil {
				t.Fatal(err)
			}
			again, _ := os.ReadFile(path)
			if string(again) != string(updated) {
				t.Fatal("not idempotent")
			}
			for _, transport := range []string{`{"url":"https://example.com"}`, `{"transport":"http"}`, `{"type":"sse"}`, `{"command":{"path":"bbx"}}`} {
				original := `{"` + key + `":{"browser-bridge":` + transport + `}}`
				installTestWrite(t, path, original)
				if _, err := installAgentMCP(target, scope, false); err == nil {
					t.Fatal("accepted conflicting transport", original)
				}
				data, _ := os.ReadFile(path)
				if string(data) != original {
					t.Fatal("changed conflicting config")
				}
				if _, err := installAgentMCP(target, scope, true); err != nil {
					t.Fatal("explicit removal failed", err)
				}
			}
		})
	}
	path := installMCPPath("muse", scope)
	installTestWrite(t, path, `{"schema_version":2}`)
	if _, err := installAgentMCP("muse", scope, false); err == nil {
		t.Fatal("silently upgraded unsupported Muse schema")
	}
}

func TestKiloMergedConfigSelection(t *testing.T) {
	_, scope := installTestScope(t)
	scope.global = false
	root := filepath.Join(scope.project, "kilo.json")
	local := filepath.Join(scope.project, ".kilo", "opencode.jsonc")
	installTestWrite(t, root, `{"theme":"root"}`)
	installTestWrite(t, local, "// local\n{}")
	if got := installMCPPath("kilo", scope); got != local {
		t.Fatal(".kilo directory should take priority", got)
	}
	if _, err := installAgentMCP("kilo", scope, false); err != nil {
		t.Fatal(err)
	}
	installTestWrite(t, root, `{"mcp":{"browser-bridge":{"type":"local","command":["other"]}}}`)
	if _, err := installAgentMCP("kilo", scope, false); err == nil {
		t.Fatal("accepted duplicate definitions across merged config files")
	}
	if _, err := installAgentMCP("kilo", scope, true); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, local} {
		raw, _ := os.ReadFile(path)
		if installMCPConfigured(string(raw), "kilo", path, scope) {
			t.Fatal("removal missed merged config", path)
		}
	}
}

func TestGooseYAMLPreservationAndRejection(t *testing.T) {
	raw := "# user config\nGOOSE_MODEL: keep\nextensions:\n  other:\n    type: builtin\n    name: developer\n  browser-bridge:\n    type: stdio\n    name: old\n    cmd: old # command comment\n    args: []\n    enabled: false\n    envs: {KEEP: secret}\n    env_keys: [PRIVATE]\n    available_tools: [browser_status]\n"
	updated, err := installUpdateGooseConfig(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, keep := range []string{"# user config", "GOOSE_MODEL: keep", "type: builtin", "enabled: false", "KEEP: secret", "env_keys: [PRIVATE]", "available_tools: [browser_status]", "cmd: bbx # command comment", "args: [mcp, serve]"} {
		if !strings.Contains(updated, keep) {
			t.Fatalf("lost %s: %s", keep, updated)
		}
	}
	again, err := installUpdateGooseConfig(updated, false)
	if err != nil || again != updated || !installGooseMCPConfigured(updated) {
		t.Fatalf("not idempotent/configured: %v\n%s", err, again)
	}
	removed, err := installUpdateGooseConfig(updated, true)
	if err != nil || installGooseMCPConfigured(removed) || !strings.Contains(removed, "type: builtin") {
		t.Fatalf("removal damaged unrelated config: %v %s", err, removed)
	}
	for _, invalid := range []string{
		"extensions: {}\nextensions: {}\n", "extensions: {}\n---\nother: 1\n", "[1, 2]", "extensions: null",
		"defaults: &defaults {}\n<<: *defaults\n", "defaults: &defaults {}\nextensions: *defaults\n",
		"extensions:\n  <<: {}\n", "extensions:\n  browser-bridge: {type: sse, uri: 'https://example.com'}\n",
		"extensions:\n  browser-bridge: {type: stdio, cmd: old, cmd: duplicate}\n",
		"extensions:\n  browser-bridge: &shared {type: stdio, cmd: old}\nother: *shared\n",
		"extensions:\n  browser-bridge: {type: stdio, cmd: &shared old}\nother: *shared\n",
	} {
		if _, err := installUpdateGooseConfig(invalid, false); err == nil {
			t.Fatalf("accepted ambiguous YAML: %s", invalid)
		}
	}
	fresh, err := installUpdateGooseConfig("", false)
	if err != nil || !strings.Contains(fresh, "enabled: true") {
		t.Fatal("missing new-entry default", err, fresh)
	}
	commentOnly, err := installUpdateGooseConfig("# comment-only config\n", false)
	if err != nil || !strings.Contains(commentOnly, "# comment-only config") {
		t.Fatal("lost comment-only config", err, commentOnly)
	}
}

func TestGrokTOMLTransportSafety(t *testing.T) {
	_, scope := installTestScope(t)
	path := installMCPPath("grok", scope)
	raw := "# user config\n[mcp_servers.'browser-bridge']\ncommand = 'old' # preserve\nargs = []\nenabled = false\nstartup_timeout_sec = 123\n[mcp_servers.'browser-bridge'.env]\nKEEP = 'secret'\n"
	installTestWrite(t, path, raw)
	if _, err := installAgentMCP("grok", scope, false); err != nil {
		t.Fatal(err)
	}
	updated, _ := os.ReadFile(path)
	for _, keep := range []string{"# user config", "# preserve", "enabled = false", "KEEP = 'secret'", "startup_timeout_sec = 123", `command = "bbx"`} {
		if !strings.Contains(string(updated), keep) {
			t.Fatal("lost", keep, string(updated))
		}
	}
	for _, invalid := range []string{
		"[mcp_servers.browser-bridge]\nurl = 'https://example.com'\n",
		"mcp_servers = { browser-bridge = { command = 'old' } }\n",
		"[mcp_servers]\nbrowser-bridge.command = 'old'\n",
		"mcp_servers.browser-bridge.command = 'old'\n",
		"[mcp_servers.browser-bridge]\n\"url\" = 'https://example.com'\n",
		"[mcp_servers.\"browser\\u002dbridge\"]\ncommand = 'old'\n",
		"[mcp_servers.browser-bridge.transport]\ntype = 'http'\n",
		"invalid =\n",
	} {
		installTestWrite(t, path, invalid)
		if _, err := installAgentMCP("grok", scope, false); err == nil {
			t.Fatal("accepted conflicting TOML", invalid)
		}
		data, _ := os.ReadFile(path)
		if string(data) != invalid {
			t.Fatal("changed conflicting TOML")
		}
	}
}

func TestExtendedSharedSkillOwnershipAndStatus(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	for _, global := range []bool{true, false} {
		scope.global = global
		targets := []string{"goose", "openhands", "agents"}
		if !global {
			targets = append(targets, "muse")
		}
		if _, err := installAgentSkill("agents", scope, false); err != nil {
			t.Fatal(err)
		}
		status := installCollectStatus(scope)
		var skills []object
		if err := json.Unmarshal(status["skillTargets"], &skills); err != nil {
			t.Fatal(err)
		}
		for _, entry := range skills {
			if installContains(targets, entry.text("key")) && entry.text("key") != "agents" && entry.boolean("installed") {
				t.Fatal("generic skill invented installation", entry)
			}
		}
		paths, err := installAgentSkills(targets, scope)
		if err != nil || len(paths) != 1 {
			t.Fatalf("not deduplicated: %v %v", paths, err)
		}
		shared := filepath.Join(installSkillBase("agents", scope), "browser-bridge", "SKILL.md")
		for i, target := range targets {
			if _, err := installAgentSkill(target, scope, true); err != nil {
				t.Fatal(err)
			}
			if installExists(shared) != (i < len(targets)-1) {
				t.Fatal("shared ownership removed wrong bundle", target)
			}
		}
	}
}

func TestOpenHandsPythonDistributionFingerprint(t *testing.T) {
	_, scope := installTestScope(t)
	bin := filepath.Join(scope.home, "venv", "bin")
	if runtime.GOOS == "windows" {
		bin = filepath.Join(scope.home, "venv", "Scripts")
	}
	t.Setenv("PATH", bin)
	path := installTestExecutable(t, filepath.Join(bin, "openhands"))
	installTestWrite(t, path, "#!/usr/bin/python\nfrom openhands_cli.entrypoint import main\n")
	if err := os.Chmod(path, 0755); err != nil {
		t.Fatal(err)
	}
	site := filepath.Join(scope.home, "venv", "lib", "python3.13", "site-packages")
	if runtime.GOOS == "windows" {
		site = filepath.Join(scope.home, "venv", "Lib", "site-packages")
	}
	dist := filepath.Join(site, "openhands-1.16.0.dist-info")
	installTestWrite(t, filepath.Join(dist, "METADATA"), "Name: openhands\nVersion: 1.16.0\n")
	installTestWrite(t, filepath.Join(dist, "entry_points.txt"), "[console_scripts]\nopenhands = openhands_cli.entrypoint:main\n")
	if installAgentDetected("openhands", scope) {
		t.Fatal("metadata without payload counted as installed")
	}
	installTestWrite(t, filepath.Join(site, "openhands_cli", "entrypoint.py"), "# module fixture")
	if !installAgentDetected("openhands", scope) {
		t.Fatal("verified distribution not detected")
	}
	installTestWrite(t, filepath.Join(dist, "METADATA"), "Name: unrelated\n")
	if installAgentDetected("openhands", scope) {
		t.Fatal("wrong distribution accepted")
	}
}

func TestExtendedNativeAndExtensionFingerprints(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	for _, target := range []string{"kilo", "grok", "goose", "muse"} {
		dir := filepath.Join(scope.home, "."+target, "bin")
		switch target {
		case "grok":
			t.Setenv("GROK_BIN_DIR", dir)
		case "goose":
			t.Setenv("GOOSE_BIN_DIR", dir)
		case "muse":
			t.Setenv("MUSE_INSTALL_DIR", dir)
		}
		path := installTestExecutable(t, filepath.Join(dir, target))
		if target == "muse" {
			if installAgentDetected(target, scope) {
				t.Fatal("unrelated muse accepted")
			}
			installTestWrite(t, path, "#!/bin/bash\nchannel_url=\"https://api.meta.ai/muse-code/channels/$channel\"\nuser_agent=\"muse-code/launcher-$version\"\n")
		}
		if !installAgentDetected(target, scope) {
			t.Fatal("native path not detected", target)
		}
		if target == "goose" {
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(executable)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0755); err != nil {
				t.Fatal(err)
			}
			if installAgentDetected(target, scope) {
				t.Fatal("Go executable counted as Rust Goose coding agent")
			}
		}
	}
	// The CLI and VS Code extension are independent installation evidence.
	if err := os.RemoveAll(filepath.Join(scope.home, ".kilo")); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(scope.home, ".vscode", "extensions")
	name := "kilocode.kilo-code-1.0.0"
	dir := filepath.Join(root, name)
	installTestWrite(t, filepath.Join(dir, "package.json"), `{"publisher":"kilocode","name":"kilo-code","main":"./dist/extension.js"}`)
	installTestWrite(t, filepath.Join(dir, "dist", "extension.js"), "// fixture")
	if !installAgentDetected("kilo", scope) {
		t.Fatal("Kilo extension not detected")
	}
	installTestWrite(t, filepath.Join(root, ".obsolete"), `{"`+name+`":true}`)
	if installAgentDetected("kilo", scope) {
		t.Fatal("obsolete Kilo extension detected")
	}
}

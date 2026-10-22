package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func installTestScope(t *testing.T) (config, installScope) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("CODEX_HOME", "")
	t.Setenv("CHROME_CONFIG_HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("BROWSER_BRIDGE_HOME", filepath.Join(home, "bridge"))
	t.Setenv("BBX_TCP_PORT", "")
	t.Setenv("BBX_TCP_HOST", "")
	t.Setenv("BBX_TCP_BIND_HOST", "")
	t.Setenv("BBX_TEST_DETECTED_MCP_CLIENTS", "")
	t.Setenv("BBX_TEST_DETECTED_SKILL_TARGETS", "")
	return config{home: filepath.Join(home, "bridge")}, installScope{global: true, home: home, project: filepath.Join(home, "project")}
}

func installTestWrite(t *testing.T, path, raw string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(raw), 0640); err != nil {
		t.Fatal(err)
	}
}

func TestInstallManifestPaths(t *testing.T) {
	home := t.TempDir()
	env := func(string) string { return "" }
	for _, platform := range []string{"darwin", "windows", "linux"} {
		seen := map[string]bool{}
		for _, browser := range installBrowsers {
			path := installManifestDir(platform, home, browser, env)
			if !strings.HasPrefix(path, home+string(filepath.Separator)) || filepath.Base(path) != "NativeMessagingHosts" || seen[path] {
				t.Fatalf("invalid %s/%s path %s", platform, browser, path)
			}
			seen[path] = true
		}
	}
	snap := filepath.Join(home, "snap", "chromium", "common", "chromium")
	if err := os.MkdirAll(snap, 0755); err != nil {
		t.Fatal(err)
	}
	if got := installManifestDir("linux", home, "chromium", env); got != filepath.Join(snap, "NativeMessagingHosts") {
		t.Fatal(got)
	}
	override := filepath.Join(home, "browser-config")
	env = func(key string) string {
		if key == "XDG_CONFIG_HOME" {
			return override
		}
		return ""
	}
	if got := installManifestDir("linux", home, "chromium", env); got != filepath.Join(override, "chromium", "NativeMessagingHosts") {
		t.Fatal(got)
	}
	if installRegistryKey("arc") != installRegistryKey("chromium") {
		t.Fatal("Arc must use Chromium registry fallback")
	}
}

func TestInstallNativePreservesManifestAndUsesNativeRoles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("registry mutation must be tested in an isolated Windows integration environment")
	}
	c, scope := installTestScope(t)
	// Explicit environment values have precedence; unset to exercise built-in.
	t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", publishedExtensionID)
	if err := os.Unsetenv("BROWSER_BRIDGE_EXTENSION_ID"); err != nil {
		t.Fatal(err)
	}
	custom := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	manifestPath := filepath.Join(installManifestDir(runtime.GOOS, scope.home, "chrome", os.Getenv), hostName+".json")
	initial := object{"allowed_origins": value([]string{"chrome-extension://" + custom + "/"}), "custom": value("keep")}
	installTestWrite(t, manifestPath, string(value(initial)))
	result, err := installNativeRegistration(context.Background(), c, "chrome", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.text("extensionId") != custom {
		t.Fatal(result)
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := decodeObject(data)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.text("custom") != "keep" {
		t.Fatal("lost custom manifest property")
	}
	launcher, err := os.ReadFile(result.text("launcherPath"))
	if err != nil {
		t.Fatal(err)
	}
	executable, _ := os.Executable()
	if !bytes.Contains(launcher, []byte(installShellQuote(executable))) || !bytes.Contains(launcher, []byte("--native-host")) || !bytes.Contains(launcher, []byte(installShellQuote(c.home))) {
		t.Fatalf("launcher %s", launcher)
	}
	info, err := os.Stat(result.text("launcherPath"))
	if err != nil || info.Mode().Perm()&0111 == 0 {
		t.Fatalf("launcher not executable: %v", err)
	}
	result, err = installNativeRegistration(context.Background(), c, "chrome", publishedExtensionID, false)
	if err != nil {
		t.Fatal(err)
	}
	var origins []string
	if err := json.Unmarshal(result["allowedOrigins"], &origins); err != nil {
		t.Fatal(err)
	}
	if len(origins) != 1 || origins[0] != "chrome-extension://"+publishedExtensionID+"/" {
		t.Fatal(origins)
	}
	removed, err := uninstallNativeRegistration(context.Background(), "chrome")
	if err != nil || len(removed) != 1 {
		t.Fatalf("uninstall: %v %v", removed, err)
	}
	if !installExists(result.text("launcherPath")) {
		t.Fatal("single-browser removal deleted shared launcher")
	}
}

func TestInstallNativeRejectsInvalidConfiguration(t *testing.T) {
	c, scope := installTestScope(t)
	t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", "")
	if _, err := installNativeRegistration(context.Background(), c, "chrome", "", false); err == nil {
		t.Fatal("accepted invalid environment extension ID")
	}
	path := filepath.Join(installManifestDir(runtime.GOOS, scope.home, "chrome", os.Getenv), hostName+".json")
	installTestWrite(t, path, "broken")
	if _, err := installNativeRegistration(context.Background(), c, "chrome", publishedExtensionID, false); err == nil {
		t.Fatal("overwrote corrupt manifest")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "broken" {
		t.Fatal(string(raw))
	}
}

func TestInstallAtomicWritePreservesSymlinkAndMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires Windows developer mode")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "dotfiles", "config.json")
	link := filepath.Join(dir, "config.json")
	installTestWrite(t, target, "old")
	if err := os.Symlink(filepath.Join("dotfiles", "config.json"), link); err != nil {
		t.Fatal(err)
	}
	if err := installAtomicWrite(link, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("replaced symlink")
	}
	data, _ := os.ReadFile(target)
	if string(data) != "new" {
		t.Fatal(string(data))
	}
	info, _ = os.Stat(target)
	if info.Mode().Perm() != 0640 {
		t.Fatalf("mode changed to %o", info.Mode().Perm())
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := installAtomicWrite(link, []byte("recreated"), 0600); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(target)
	if string(data) != "recreated" {
		t.Fatal(string(data))
	}
}

func TestInstallMCPAllClientsAndCopilotProfiles(t *testing.T) {
	_, scope := installTestScope(t)
	profile := filepath.Join(installVSCodeHome(scope), "User", "profiles", "work")
	if err := os.MkdirAll(profile, 0755); err != nil {
		t.Fatal(err)
	}
	for _, global := range []bool{true, false} {
		scope.global = global
		for _, client := range installAgentNames {
			paths, err := installAgentMCP(client, scope, false)
			if err != nil {
				t.Fatalf("%s: %v", client, err)
			}
			want := 1
			if client == "copilot" && global {
				want = 3
			}
			if len(paths) != want {
				t.Fatalf("%s: paths %v", client, paths)
			}
			for _, path := range paths {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if !installMCPConfigured(string(raw), client, path, scope) {
					t.Fatalf("not configured %s: %s", path, raw)
				}
				if client == "copilot" {
					key := installMCPKey(client, path, scope)
					if path == filepath.Join(scope.home, ".copilot", "mcp-config.json") && key != "mcpServers" {
						t.Fatal(key)
					}
					if strings.Contains(path, "User") && key != "servers" {
						t.Fatal(key)
					}
				}
			}
			if _, err := installAgentMCP(client, scope, true); err != nil {
				t.Fatal(err)
			}
			for _, path := range paths {
				raw, _ := os.ReadFile(path)
				if installMCPConfigured(string(raw), client, path, scope) {
					t.Fatalf("still configured %s", path)
				}
			}
		}
	}
}

func TestInstallJSONCPreservesCommentsAndUserSettings(t *testing.T) {
	_, scope := installTestScope(t)
	raw := `// user header
{
  "mcpServers": {
    "other": {"command":"custom"}, // keep other server
    "browser-bridge": {
      "command": "node", // launcher note
      "args": ["legacy.js"],
      "env": {"TOKEN":"private"},
      "timeout": 123,
    },
  },
  "theme": "dark", /* user tail */
}
`
	path := installMCPPath("claude", scope)
	updated, err := installUpdateJSONConfig(raw, "claude", path, scope, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, keep := range []string{"// user header", "// keep other server", "// launcher note", `"TOKEN":"private"`, `"timeout": 123`, `"theme": "dark"`, "/* user tail */", `"other": {"command":"custom"}`} {
		if !strings.Contains(updated, keep) {
			t.Fatalf("lost %s in %s", keep, updated)
		}
	}
	root, err := installParseJSON(updated)
	if err != nil {
		t.Fatal(err)
	}
	command := installJSONLookup(root, "mcpServers", "browser-bridge", "command")
	if got := updated[command.start:command.end]; got != `"bbx"` {
		t.Fatal(got)
	}
	again, err := installUpdateJSONConfig(updated, "claude", path, scope, false)
	if err != nil || again != updated {
		t.Fatalf("not idempotent: %v\n%s", err, again)
	}
	removed, err := installUpdateJSONConfig(updated, "claude", path, scope, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := installParseJSON(removed); err != nil {
		t.Fatalf("invalid result: %v\n%s", err, removed)
	}
	if !strings.Contains(removed, `"other": {"command":"custom"}`) || !strings.Contains(removed, "/* user tail */") {
		t.Fatal(removed)
	}
}

func TestInstallJSONRejectsInvalidWithoutWriting(t *testing.T) {
	_, scope := installTestScope(t)
	path := installMCPPath("cursor", scope)
	for _, raw := range []string{`[]`, `{"mcpServers":42}`, `{"mcpServers":{"browser-bridge":42}}`, `{"a":1,"a":2}`, `{"a":1 "b":2}`, `{/* unterminated`} {
		installTestWrite(t, path, raw)
		if _, err := installAgentMCP("cursor", scope, false); err == nil {
			t.Fatalf("accepted %s", raw)
		}
		data, _ := os.ReadFile(path)
		if string(data) != raw {
			t.Fatalf("modified invalid config %s", raw)
		}
	}
}

func TestInstallJSONDeletePositions(t *testing.T) {
	for _, raw := range []string{`{"a":1}`, `{"a":1,"b":2}`, `{"b":2,"a":1}`, `{"b":2,"a":1,}`, `{"a":1 /* note */,"b":2}`, "{\n// note\n\"a\":1\n}"} {
		updated, err := installJSONEdit(raw, []string{"a"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		root, err := installParseJSON(updated)
		if err != nil {
			t.Fatalf("%s -> %s: %v", raw, updated, err)
		}
		if installJSONLookup(root, "a") != nil {
			t.Fatal(updated)
		}
		if strings.Contains(raw, "note") && !strings.Contains(updated, "note") {
			t.Fatal("lost comment")
		}
	}
}

func TestInstallJSONCPreservesByteOrderMark(t *testing.T) {
	raw := "\xef\xbb\xbf{\"theme\": \"dark\"}\n"
	replacement := `{"command":"bbx"}`
	updated, err := installJSONEdit(raw, []string{"mcpServers", "browser-bridge"}, &replacement)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(updated, "\xef\xbb\xbf") || !strings.Contains(updated, `"theme": "dark"`) {
		t.Fatal(updated)
	}
	if _, err := installParseJSON(updated); err != nil {
		t.Fatal(err)
	}
}

func TestInstallCodexPreservesCustomTablesAndMultilineValues(t *testing.T) {
	raw := `# User preference
model = "test"
prompt = '''
[mcp_servers."browser-bridge"]
not a table
'''

[mcp_servers."browser-bridge"] # own header
command = "node" # keep command comment
args = [
  "old.js",
] # keep args comment
startup_timeout_sec = 20

[mcp_servers."browser-bridge".env]
SECRET = "user-value"

[mcp_servers.other]
command = "custom"
`
	updated, err := installUpdateCodex(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, keep := range []string{`model = "test"`, `command = "bbx" # keep command comment`, `args = ["mcp", "serve"] # keep args comment`, `startup_timeout_sec = 20`, `SECRET = "user-value"`, `command = "custom"`, `not a table`} {
		if !strings.Contains(updated, keep) {
			t.Fatalf("lost %s in %s", keep, updated)
		}
	}
	again, err := installUpdateCodex(updated, false)
	if err != nil || again != updated {
		t.Fatalf("not idempotent: %v\n%s", err, again)
	}
	removed, err := installUpdateCodex(updated, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(removed, `SECRET =`) || strings.Contains(removed, `startup_timeout_sec`) {
		t.Fatal(removed)
	}
	if !strings.Contains(removed, "not a table") || !strings.Contains(removed, `command = "custom"`) {
		t.Fatal(removed)
	}
	if installMCPConfigured(removed, "codex", "", installScope{}) {
		t.Fatal("fake header in multiline string was counted")
	}
}

func TestInstallCodexAddsMissingFieldsInCorrectSection(t *testing.T) {
	raw := "[mcp_servers.browser-bridge]\ncommand = 'old'\n# custom\n[mcp_servers.other]\ncommand = 'other'\n"
	updated, err := installUpdateCodex(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Index(updated, "args =") > strings.Index(updated, "[mcp_servers.other]") {
		t.Fatal(updated)
	}
	if !strings.Contains(updated, "# custom") {
		t.Fatal(updated)
	}
}

func TestInstallSkillsPreserveCustomFilesAndSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires Windows developer mode")
	}
	_, scope := installTestScope(t)
	path := filepath.Join(installSkillBase("copilot", scope), "browser-bridge")
	if _, err := installAgentSkill("copilot", scope, false); err != nil {
		t.Fatal(err)
	}
	skill, err := os.ReadFile(filepath.Join(path, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(skill, []byte("## GitHub Copilot Note")) {
		t.Fatal("Copilot note missing")
	}
	installTestWrite(t, filepath.Join(path, "custom.md"), "user notes")
	if err := os.Symlink("custom.md", filepath.Join(path, "notes-link")); err != nil {
		t.Fatal(err)
	}
	resolved := filepath.Join(scope.home, "managed-skill")
	if err := os.Rename(path, resolved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(resolved, path); err != nil {
		t.Fatal(err)
	}
	if _, err := installAgentSkill("copilot", scope, false); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Lstat(path)
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("removed top-level link")
	}
	if _, err := installAgentSkill("copilot", scope, true); err != nil {
		t.Fatal(err)
	}
	custom, err := os.ReadFile(filepath.Join(path, "custom.md"))
	if err != nil || string(custom) != "user notes" {
		t.Fatal("lost user file")
	}
	info, _ = os.Lstat(filepath.Join(path, "notes-link"))
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("lost user symlink")
	}
	if installExists(filepath.Join(path, "SKILL.md")) || installExists(filepath.Join(path, installSkillSentinel)) {
		t.Fatal("left managed files")
	}
}

func TestInstallSkillsProtectUnmanagedAndEditedFiles(t *testing.T) {
	_, scope := installTestScope(t)
	path := filepath.Join(installSkillBase("agents", scope), "browser-bridge")
	installTestWrite(t, filepath.Join(path, "SKILL.md"), "custom skill")
	if _, err := installAgentSkill("agents", scope, false); err == nil {
		t.Fatal("overwrote unmanaged skill")
	}
	if paths, err := installAgentSkill("agents", scope, true); err != nil || len(paths) != 0 {
		t.Fatal("removed unmanaged skill")
	}
	if err := os.RemoveAll(path); err != nil {
		t.Fatal(err)
	}
	if _, err := installAgentSkill("agents", scope, false); err != nil {
		t.Fatal(err)
	}
	installTestWrite(t, filepath.Join(path, "SKILL.md"), "my local edits")
	if _, err := installAgentSkill("agents", scope, false); err == nil {
		t.Fatal("overwrote local edits")
	}
	if _, err := installAgentSkill("agents", scope, true); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(path, "SKILL.md"))
	if string(data) != "my local edits" {
		t.Fatal("uninstall deleted user edits")
	}
}

func TestSetupStatusAndInstallContract(t *testing.T) {
	c, _ := installTestScope(t)
	for _, kind := range []string{"mcp", "skill"} {
		result, err := setupInstall(c, object{"kind": value(kind), "target": value(" CoDeX ")})
		if err != nil {
			t.Fatal(err)
		}
		if result.text("action") != "install" || result.text("target") != "codex" || result.text("kind") != kind {
			t.Fatal(result)
		}
	}
	status, err := setupStatus(c)
	if err != nil {
		t.Fatal(err)
	}
	if status.text("scope") != "global" {
		t.Fatal(status)
	}
	for _, key := range []string{"mcpClients", "skillTargets"} {
		var entries []object
		if err := json.Unmarshal(status[key], &entries); err != nil {
			t.Fatal(err)
		}
		if len(entries) != len(installAgentNames) {
			t.Fatal(entries)
		}
		for i, entry := range entries {
			if entry.text("key") != installAgentNames[i] {
				t.Fatal("agent order changed")
			}
			if entry.text("label") != installAgentLabels[installAgentNames[i]] {
				t.Fatal("agent label does not match setup UI", entry)
			}
			if entry.text("key") == "codex" && entry.text("label") != "Codex (OpenAI)" {
				t.Fatal("Codex setup label must identify the vendor", entry)
			}
			if entry.text("key") == "windsurf" && entry.text("label") != "Devin Desktop" {
				t.Fatal("legacy Windsurf target must display the current product name", entry)
			}
		}
		if key == "mcpClients" && !entries[0].boolean("configured") {
			t.Fatal(entries[0])
		}
		if key == "skillTargets" && (!entries[0].boolean("installed") || !entries[0].boolean("managed") || entries[0].boolean("updateAvailable")) {
			t.Fatal(entries[0])
		}
	}
	for _, kind := range []string{"mcp", "skill"} {
		if _, err := setupInstall(c, object{"kind": value(kind), "target": value("codex"), "action": value("uninstall")}); err != nil {
			t.Fatal(err)
		}
	}
	for _, params := range []object{{"kind": value("bad"), "target": value("codex")}, {"kind": value("mcp"), "target": value("all")}, {"kind": value("mcp"), "target": value("codex"), "action": value("bad")}, {"kind": value("mcp"), "target": value("codex"), "action": value(42)}} {
		if _, err := setupInstall(c, params); err == nil {
			t.Fatalf("accepted %s", value(params))
		}
	}
}

func TestDevinDesktopDetection(t *testing.T) {
	for _, command := range []string{"devin-desktop", "surf", "windsurf"} {
		t.Run(command, func(t *testing.T) {
			_, scope := installTestScope(t)
			bin := t.TempDir()
			t.Setenv("PATH", bin)
			name := command
			if runtime.GOOS == "windows" {
				name += ".exe"
				t.Setenv("PATHEXT", ".EXE")
			}
			path := filepath.Join(bin, name)
			installTestWrite(t, path, "#!/bin/sh\n")
			if err := os.Chmod(path, 0755); err != nil {
				t.Fatal(err)
			}
			if !installAgentDetected("windsurf", scope) {
				t.Fatalf("Devin Desktop not detected from %s", command)
			}
		})
	}
	if runtime.GOOS == "darwin" {
		for _, app := range []string{"Devin.app", "Windsurf.app"} {
			t.Run(app, func(t *testing.T) {
				_, scope := installTestScope(t)
				t.Setenv("PATH", t.TempDir())
				if err := os.MkdirAll(filepath.Join(scope.home, "Applications", app), 0755); err != nil {
					t.Fatal(err)
				}
				if !installAgentDetected("windsurf", scope) {
					t.Fatalf("Devin Desktop not detected from %s", app)
				}
			})
		}
	}
}

func TestInstallDefaultSelectionAndAliases(t *testing.T) {
	_, scope := installTestScope(t)
	targets, installed := installDefaultTargets(scope, true)
	if len(targets) != 1 || targets[0] != "agents" || len(installed) != 0 {
		t.Fatal(targets, installed)
	}
	targets, _ = installDefaultTargets(scope, false)
	if len(targets) != 8 {
		t.Fatal(targets)
	}
	if _, err := installAgentMCP("cursor", scope, false); err != nil {
		t.Fatal(err)
	}
	targets, _ = installDefaultTargets(scope, false)
	if len(targets) != 1 || targets[0] != "cursor" {
		t.Fatal(targets)
	}
	aliases, err := installParseTargets("openai,google,codex", true)
	if err != nil || strings.Join(aliases, ",") != "codex,antigravity" {
		t.Fatal(aliases, err)
	}
	if _, err := installParseTargets("openai", false); err == nil {
		t.Fatal("MCP unexpectedly accepted skill alias")
	}
	if _, _, err := installParseAgentArgs([]string{"--project"}, true); err == nil {
		t.Fatal("accepted missing project")
	}
}

func TestInstallSkillGroupRollsBackNewDirectories(t *testing.T) {
	_, scope := installTestScope(t)
	if _, err := installAgentSkill("codex", scope, false); err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(installSkillBase("cursor", scope), "browser-bridge")
	installTestWrite(t, filepath.Join(blocked, "SKILL.md"), "unmanaged")
	if _, err := installAgentSkills([]string{"codex", "claude", "cursor"}, scope); err == nil {
		t.Fatal("expected unmanaged target failure")
	}
	if !installExists(filepath.Join(installSkillBase("codex", scope), "browser-bridge", "SKILL.md")) {
		t.Fatal("rollback removed pre-existing bundle")
	}
	if installExists(filepath.Join(installSkillBase("claude", scope), "browser-bridge")) {
		t.Fatal("rollback left newly created bundle")
	}
	data, _ := os.ReadFile(filepath.Join(blocked, "SKILL.md"))
	if string(data) != "unmanaged" {
		t.Fatal("changed unmanaged target")
	}
}

func TestInstallEmbeddedSkillMatchesSharedSource(t *testing.T) {
	files, err := installSkillFiles("agents")
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join("..", "..", "skills", "browser-bridge")
	if err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(files[name], data) {
			t.Errorf("embedded skill %s differs from shared source; regenerate assets/skills.bundle", name)
		}
		delete(files, name)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("embedded bundle has obsolete files: %v", files)
	}
}

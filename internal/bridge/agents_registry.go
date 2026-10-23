package bridge

import (
	"os"
	"path/filepath"
	"runtime"
)

type installConfigFormat uint8

const (
	installConfigJSON installConfigFormat = iota
	installConfigTOML
	installConfigYAML
)

type installTransportPolicy uint8

const (
	installTransportLegacy installTransportPolicy = iota
	installTransportStdio
	installTransportNestedStdio
	installTransportLocalArray
	installTransportStringStdio
)

type installAgentMCPDefinition struct {
	format        installConfigFormat
	key           string
	keyForPath    func(string, installScope) string
	entry         object
	userOnly      bool
	paths         func(installScope) []string
	removePaths   func(installScope) []string
	validateScope func(installScope) error
	validateRaw   func(string) error
	transport     installTransportPolicy
	schemaVersion int
	lockSuffix    string
}

type installAgentSkillDefinition struct {
	base          func(installScope) string
	sharedUser    bool
	sharedProject bool
	note          string
}

type installAgentDefinition struct {
	key      string
	label    string
	aliases  []string
	mcp      installAgentMCPDefinition
	skill    installAgentSkillDefinition
	presence installAgentPresence
}

// The ordered registry owns every supported agent's identity and setup behavior.
// Add agents here, not to parallel target switches in the shared installers.
// The setup response also supplies this order to the extension UI.
var installAgentRegistry []installAgentDefinition

// Compatibility views are derived, never separately maintained target lists.
var installAgentNames []string
var installAgentLabels map[string]string

func init() {
	installAgentRegistry = []installAgentDefinition{
		{
			key: "codex", label: "Codex (OpenAI)", aliases: []string{"openai"},
			mcp:      installAgentMCPDefinition{format: installConfigTOML, key: "mcp_servers", paths: installHomeConfigPaths(installCodexHome, "config.toml", ".codex/config.toml")},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".codex/skills", ".codex/skills")},
			presence: installAgentPresence{legacy: true, commands: []string{"codex"}, homeHints: []string{".codex"}},
		},
		{
			key: "claude", label: "Claude Code",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(true), paths: installScopedConfigPaths(".claude.json", ".mcp.json")},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".claude/skills", ".claude/skills")},
			presence: installAgentPresence{legacy: true, commands: []string{"claude"}, homeHints: []string{".claude", ".claude.json"}},
		},
		{
			key: "opencode", label: "OpenCode",
			mcp:      installAgentMCPDefinition{key: "mcp", entry: installLocalArrayEntry(), paths: installScopedConfigPaths(".config/opencode/opencode.json", "opencode.json")},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".opencode/skills", ".opencode/skills")},
			presence: installAgentPresence{legacy: true, commands: []string{"opencode"}, homeHints: []string{".config/opencode", ".opencode"}},
		},
		{
			key: "copilot", label: "GitHub Copilot",
			mcp:      installAgentMCPDefinition{keyForPath: installCopilotMCPKey, entry: installStdioEntry(true), paths: installCopilotMCPPaths},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".copilot/skills", ".github/skills"), note: installCopilotNote},
			presence: installAgentPresence{legacy: true, commands: []string{"code"}, homeHints: []string{".vscode"}, apps: []string{"Visual Studio Code.app"}, detect: installCopilotDetected},
		},
		{
			key: "cursor", label: "Cursor",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), paths: installScopedConfigPaths(".cursor/mcp.json", ".cursor/mcp.json")},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".cursor/skills", ".cursor/skills")},
			presence: installAgentPresence{legacy: true, commands: []string{"cursor"}, homeHints: []string{".cursor"}, apps: []string{"Cursor.app"}},
		},
		{
			// Keep the target key and paths compatible with existing Windsurf installs.
			key: "windsurf", label: "Devin Desktop",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), paths: installScopedConfigPaths(".codeium/windsurf/mcp_config.json", ".windsurf/mcp_config.json")},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".codeium/windsurf/skills", ".windsurf/skills")},
			presence: installAgentPresence{legacy: true, commands: []string{"devin-desktop", "surf", "windsurf"}, homeHints: []string{".codeium/windsurf"}, apps: []string{"Devin.app", "Windsurf.app"}},
		},
		{
			key: "antigravity", label: "Antigravity", aliases: []string{"google"},
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), paths: installScopedConfigPaths(".gemini/antigravity/mcp_config.json", ".agents/mcp_config.json")},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".gemini/antigravity/skills", ".agents/skills")},
			presence: installAgentPresence{legacy: true, commands: []string{"agy"}, homeHints: []string{".gemini/antigravity"}},
		},
		{
			key: "gemini", label: "Gemini CLI",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), transport: installTransportStdio, paths: installHomeConfigPaths(installGeminiHome, ".gemini/settings.json", ".gemini/settings.json")},
			skill:    installAgentSkillDefinition{base: installHomeSkillDirectory(installGeminiHome, ".gemini/skills", ".gemini/skills")},
			presence: installAgentPresence{commands: []string{"gemini"}, packages: []string{"@google/gemini-cli"}},
		},
		{
			key: "cline", label: "Cline",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(true), userOnly: true, paths: installClineMCPPaths, transport: installTransportNestedStdio, lockSuffix: ".lock"},
			skill:    installAgentSkillDefinition{base: installHomeSkillDirectory(installClineHome, "skills", ".cline/skills")},
			presence: installAgentPresence{commands: []string{"cline"}, packages: []string{"cline", "@cline/cli"}, extension: installExtensionIdentity{publisher: "saoudrizwan", name: "claude-dev"}},
		},
		{
			key: "zed", label: "Zed",
			mcp:      installAgentMCPDefinition{key: "context_servers", entry: installStdioEntry(false), paths: installHomeConfigPaths(installZedHome, "settings.json", ".zed/settings.json"), transport: installTransportStdio},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".agents/skills", ".agents/skills"), sharedUser: true, sharedProject: true},
			presence: installAgentPresence{detect: installZedDetected},
		},
		{
			key: "amp", label: "Amp",
			mcp:      installAgentMCPDefinition{key: "amp.mcpServers", entry: installStdioEntry(false), paths: installAmpMCPPaths, removePaths: installAmpConfigCandidates, validateScope: installValidateAmpScope, transport: installTransportStdio},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".config/amp/skills", ".agents/skills"), sharedProject: true},
			presence: installAgentPresence{commands: []string{"amp"}, packages: []string{"@ampcode/cli", "@sourcegraph/amp"}, packagePrefixes: []string{"@ampcode/cli-"}, nativePaths: installNativePaths("AMP_HOME", ".amp", "bin/amp", "bin/amp")},
		},
		{
			key: "droid", label: "Factory Droid",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(true), paths: installScopedConfigPaths(".factory/mcp.json", ".factory/mcp.json"), transport: installTransportStdio},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".factory/skills", ".factory/skills")},
			presence: installAgentPresence{commands: []string{"droid"}, packages: []string{"droid"}, packagePrefixes: []string{"@factory/cli-"}, dependencyPrefixes: []string{"@factory/cli-"}, nativePaths: installNativePaths("", "", ".local/bin/droid", "bin/droid")},
		},
		{
			key: "pi", label: "Pi",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), paths: installHomeConfigPaths(installPiHome, "mcp.json", ".pi/mcp.json"), transport: installTransportStdio},
			skill:    installAgentSkillDefinition{base: installHomeSkillDirectory(installPiHome, "skills", ".pi/skills")},
			presence: installAgentPresence{commands: []string{"pi"}, packages: []string{"@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"}},
		},
		{
			key: "kilo", label: "Kilo Code",
			mcp:      installAgentMCPDefinition{key: "mcp", entry: installLocalArrayEntry(), paths: installKiloMCPPaths, removePaths: installKiloConfigCandidates, validateScope: installValidateKiloScope, transport: installTransportLocalArray},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".kilo/skills", ".kilo/skills")},
			presence: installAgentPresence{commands: []string{"kilo"}, packages: []string{"@kilocode/cli"}, nativePaths: installNativePaths("", "", ".kilo/bin/kilo", ".kilo/bin/kilo"), extension: installExtensionIdentity{publisher: "kilocode", name: "kilo-code"}},
		},
		{
			key: "qwen", label: "Qwen Code",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), paths: installHomeConfigPaths(installQwenHome, "settings.json", ".qwen/settings.json"), transport: installTransportStdio},
			skill:    installAgentSkillDefinition{base: installHomeSkillDirectory(installQwenHome, "skills", ".qwen/skills")},
			presence: installAgentPresence{commands: []string{"qwen"}, packages: []string{"@qwen-code/qwen-code"}},
		},
		{
			key: "goose", label: "Goose",
			mcp:      installAgentMCPDefinition{format: installConfigYAML, key: "extensions", userOnly: true, paths: installHomeConfigPaths(installGooseHome, "config.yaml", "")},
			skill:    installAgentSkillDefinition{base: installGooseSkillDirectory, sharedUser: true, sharedProject: true},
			presence: installAgentPresence{nativePaths: installNativePaths("GOOSE_BIN_DIR", "", ".local/bin/goose", "goose/goose"), nativeMatch: installGooseExecutableMatches},
		},
		{
			key: "openhands", label: "OpenHands",
			mcp:      installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(false), userOnly: true, paths: installHomeConfigPaths(installOpenHandsHome, "mcp.json", ""), transport: installTransportStdio},
			skill:    installAgentSkillDefinition{base: installScopedDirectory(".agents/skills", ".agents/skills"), sharedUser: true, sharedProject: true},
			presence: installAgentPresence{commands: []string{"openhands"}, pathMatch: installOpenHandsPythonMatches, nativePaths: installNativePaths("", "", ".local/bin/openhands", ".local/bin/openhands"), nativeMatch: installOpenHandsPythonMatches},
		},
		{
			key: "muse", label: "Muse Code",
			mcp:      installAgentMCPDefinition{key: "mcp_servers", entry: object{"transport": value("stdio"), "command": value("bbx"), "args": value([]string{"mcp", "serve"}), "env": value(object{}), "mode": value("optional")}, userOnly: true, paths: installHomeConfigPaths(installMuseHome, "settings.json", ""), transport: installTransportStringStdio, schemaVersion: 1},
			skill:    installAgentSkillDefinition{base: installHomeSkillDirectory(installMuseHome, "skills", ".agents/skills"), sharedProject: true},
			presence: installAgentPresence{commands: []string{"muse"}, pathMatch: installMuseLauncherMatches, nativePaths: installNativePaths("MUSE_INSTALL_DIR", "", ".local/bin/muse", ".local/bin/muse"), nativeMatch: installMuseLauncherMatches},
		},
		{
			key: "grok", label: "Grok Build",
			mcp:      installAgentMCPDefinition{format: installConfigTOML, key: "mcp_servers", paths: installHomeConfigPaths(installGrokHome, "config.toml", ".grok/config.toml"), validateRaw: installValidateGrokConfig},
			skill:    installAgentSkillDefinition{base: installHomeSkillDirectory(installGrokHome, "skills", ".grok/skills")},
			presence: installAgentPresence{commands: []string{"grok"}, packages: []string{"@xai-official/grok"}, nativePaths: installNativePaths("GROK_BIN_DIR", "", ".grok/bin/grok", ".grok/bin/grok")},
		},
		{
			key: "agents", label: "Generic agents",
			mcp:   installAgentMCPDefinition{key: "mcpServers", entry: installStdioEntry(true), paths: installScopedConfigPaths(".agents/mcp.json", ".agents/mcp.json")},
			skill: installAgentSkillDefinition{base: installScopedDirectory(".agents/skills", ".agents/skills")},
		},
	}
	installAgentLabels = map[string]string{}
	for _, agent := range installAgentRegistry {
		installAgentNames = append(installAgentNames, agent.key)
		installAgentLabels[agent.key] = agent.label
	}
}

func installAgentByKey(key string) *installAgentDefinition {
	for i := range installAgentRegistry {
		if installAgentRegistry[i].key == key {
			return &installAgentRegistry[i]
		}
	}
	return nil
}

func installStdioEntry(explicitType bool) object {
	entry := object{"command": value("bbx"), "args": value([]string{"mcp", "serve"}), "env": value(object{})}
	if explicitType {
		entry["type"] = value("stdio")
	}
	return entry
}

func installLocalArrayEntry() object {
	return object{"type": value("local"), "command": value([]string{"bbx", "mcp", "serve"})}
}

func installScopedDirectory(user, project string) func(installScope) string {
	return func(scope installScope) string {
		if scope.global {
			return filepath.Join(scope.home, filepath.FromSlash(user))
		}
		return filepath.Join(scope.project, filepath.FromSlash(project))
	}
}

func installHomeSkillDirectory(home func(installScope) string, user, project string) func(installScope) string {
	return func(scope installScope) string {
		if scope.global {
			return filepath.Join(home(scope), filepath.FromSlash(user))
		}
		return filepath.Join(scope.project, filepath.FromSlash(project))
	}
}

func installScopedConfigPaths(user, project string) func(installScope) []string {
	directory := installScopedDirectory(user, project)
	return func(scope installScope) []string { return []string{directory(scope)} }
}

func installHomeConfigPaths(home func(installScope) string, user, project string) func(installScope) []string {
	return func(scope installScope) []string {
		if scope.global {
			return []string{filepath.Join(home(scope), filepath.FromSlash(user))}
		}
		if project == "" {
			return nil
		}
		return []string{filepath.Join(scope.project, filepath.FromSlash(project))}
	}
}

func installNativePaths(env, root, unix, windows string) func(installScope) []string {
	return func(scope installScope) []string {
		relative := unix
		if runtime.GOOS == "windows" {
			relative = windows
		}
		base := filepath.Join(scope.home, filepath.FromSlash(root))
		if custom := os.Getenv(env); env != "" && custom != "" {
			base = installExpandedHome(custom, scope)
			if root == "" {
				relative = filepath.Base(filepath.FromSlash(relative))
			}
		}
		path := filepath.Join(base, filepath.FromSlash(relative))
		if runtime.GOOS == "windows" {
			path += ".exe"
		}
		return []string{path}
	}
}

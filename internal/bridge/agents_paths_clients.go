package bridge

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Client-specific resolution hooks referenced by agents_registry.go. Simple
// home/project paths belong directly in registry entries.
func installCodexHome(scope installScope) string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return home
	}
	return filepath.Join(scope.home, ".codex")
}

func installGeminiHome(scope installScope) string {
	if home := os.Getenv("GEMINI_CLI_HOME"); home != "" {
		return home
	}
	return scope.home
}

func installClineHome(scope installScope) string {
	if home := os.Getenv("CLINE_DIR"); home != "" {
		return home
	}
	return filepath.Join(scope.home, ".cline")
}

func installZedHome(scope installScope) string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(scope.home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Zed")
	case "linux":
		for _, env := range []string{"FLATPAK_XDG_CONFIG_HOME", "XDG_CONFIG_HOME"} {
			if base := os.Getenv(env); base != "" {
				return filepath.Join(base, "zed")
			}
		}
	}
	return filepath.Join(scope.home, ".config", "zed")
}

func installCopilotMCPPaths(scope installScope) []string {
	if !scope.global {
		return []string{filepath.Join(scope.project, ".vscode", "mcp.json")}
	}
	user := filepath.Join(installVSCodeHome(scope), "User")
	paths := []string{filepath.Join(scope.home, ".copilot", "mcp-config.json"), filepath.Join(user, "mcp.json")}
	profiles := filepath.Join(user, "profiles")
	entries, _ := os.ReadDir(profiles)
	for _, entry := range entries {
		if entry.IsDir() {
			paths = append(paths, filepath.Join(profiles, entry.Name(), "mcp.json"))
		}
	}
	return paths
}

func installCopilotMCPKey(path string, scope installScope) string {
	if filepath.Clean(path) == filepath.Join(scope.home, ".copilot", "mcp-config.json") {
		return "mcpServers"
	}
	return "servers"
}

func installClineMCPPaths(scope installScope) []string {
	if path := os.Getenv("CLINE_MCP_SETTINGS_PATH"); path != "" {
		return []string{path}
	}
	data := os.Getenv("CLINE_DATA_DIR")
	if data == "" {
		data = filepath.Join(installClineHome(scope), "data")
	}
	return []string{filepath.Join(data, "settings", "cline_mcp_settings.json")}
}

func installAmpConfigCandidates(scope installScope) []string {
	dir := installScopedDirectory(".config/amp", ".amp")(scope)
	return []string{filepath.Join(dir, "settings.json"), filepath.Join(dir, "settings.jsonc")}
}

func installAmpMCPPaths(scope installScope) []string {
	paths := installAmpConfigCandidates(scope)
	if !installExists(paths[0]) && installExists(paths[1]) {
		return paths[1:]
	}
	return paths[:1]
}

func installValidateAmpScope(scope installScope) error {
	paths := installAmpConfigCandidates(scope)
	if installExists(paths[0]) && installExists(paths[1]) {
		return fmt.Errorf("both %s and %s exist; select one Amp settings file before installing", paths[0], paths[1])
	}
	return nil
}

func installExpandedHome(path string, scope installScope) string {
	if path == "~" {
		return scope.home
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, "~\\") {
		return filepath.Join(scope.home, filepath.FromSlash(strings.ReplaceAll(path[2:], "\\", "/")))
	}
	return path
}

func installPiHome(scope installScope) string {
	if dir := os.Getenv("PI_CODING_AGENT_DIR"); dir != "" {
		return installExpandedHome(dir, scope)
	}
	return filepath.Join(scope.home, ".pi", "agent")
}

func installQwenHome(scope installScope) string {
	if dir := os.Getenv("QWEN_HOME"); dir != "" {
		return installExpandedHome(dir, scope)
	}
	return filepath.Join(scope.home, ".qwen")
}

func installGrokHome(scope installScope) string {
	if dir := os.Getenv("GROK_HOME"); dir != "" {
		return installExpandedHome(dir, scope)
	}
	return filepath.Join(scope.home, ".grok")
}

func installMuseHome(scope installScope) string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(scope.home, ".config")
	}
	return filepath.Join(base, "muse")
}

func installGooseHome(scope installScope) string {
	if root := os.Getenv("GOOSE_PATH_ROOT"); filepath.IsAbs(root) {
		return filepath.Join(root, "config")
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("APPDATA")
		if base == "" {
			base = filepath.Join(scope.home, "AppData", "Roaming")
		}
		return filepath.Join(base, "Block", "goose", "config")
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(scope.home, ".config")
	}
	return filepath.Join(base, "goose")
}

func installGooseSkillDirectory(scope installScope) string {
	if scope.global {
		if root := os.Getenv("GOOSE_PATH_ROOT"); filepath.IsAbs(root) {
			return filepath.Join(root, ".agents", "skills")
		}
		return filepath.Join(scope.home, ".agents", "skills")
	}
	return filepath.Join(scope.project, ".agents", "skills")
}

func installOpenHandsHome(scope installScope) string {
	base := os.Getenv("OPENHANDS_PERSISTENCE_DIR")
	if base == "" {
		base = filepath.Join(scope.home, ".openhands")
	}
	return installExpandedHome(base, scope)
}

func installKiloConfigCandidates(scope installScope) []string {
	dirs := []string{filepath.Join(scope.project, ".kilo"), scope.project}
	if scope.global {
		dirs = []string{filepath.Join(scope.home, ".config", "kilo")}
	}
	var paths []string
	for _, dir := range dirs {
		for _, name := range []string{"kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json", "config.json"} {
			paths = append(paths, filepath.Join(dir, name))
		}
	}
	return paths
}

func installKiloMCPPaths(scope installScope) []string {
	candidates := installKiloConfigCandidates(scope)
	for _, path := range candidates {
		if raw, err := os.ReadFile(path); err == nil && installMCPConfigured(string(raw), "kilo", path, scope) {
			return []string{path}
		}
	}
	for _, path := range candidates {
		if installExists(path) {
			return []string{path}
		}
	}
	return candidates[:1]
}

func installValidateKiloScope(scope installScope) error {
	configured := 0
	for _, path := range installKiloConfigCandidates(scope) {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if _, err := installParseJSON(string(data)); err != nil {
			return fmt.Errorf("cannot merge Kilo settings %s: %w", path, err)
		}
		if installMCPConfigured(string(data), "kilo", path, scope) {
			configured++
		}
	}
	if configured > 1 {
		return errors.New("browser-bridge is defined in multiple Kilo settings files; consolidate the entry before installing")
	}
	return nil
}

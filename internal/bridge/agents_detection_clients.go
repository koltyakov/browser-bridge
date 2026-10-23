package bridge

import (
	"debug/buildinfo"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func installCopilotDetected(scope installScope) bool {
	if installExists(filepath.Join(installVSCodeHome(scope), "User")) {
		return true
	}
	if runtime.GOOS == "windows" {
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			local = filepath.Join(scope.home, "AppData", "Local")
		}
		return installExists(filepath.Join(local, "Programs", "Microsoft VS Code"))
	}
	return false
}

func installGooseExecutableMatches(path string) bool {
	// The SQL migration CLI shares the name and may use the same directory.
	// Official Goose is Rust, so Go build metadata rules out the coding agent.
	_, err := buildinfo.ReadFile(path)
	return err != nil
}

func installMuseLauncherMatches(path string) bool {
	if !installExecutableExists(path) {
		return false
	}
	// Inspect the official shell launcher without running its updater/auth flow.
	raw, err := installReadFingerprint(path)
	return err == nil && strings.Contains(string(raw), "https://api.meta.ai/muse-code/channels/") && strings.Contains(string(raw), "muse-code/launcher-")
}

// Inspect the resolved virtualenv and distribution, never run Python or pip.
// A retained .openhands directory and an unrelated entrypoint are insufficient.
func installOpenHandsPythonMatches(path string) bool {
	if !installExecutableExists(path) {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	if runtime.GOOS != "windows" {
		raw, err := installReadFingerprint(resolved)
		if err != nil || !strings.Contains(string(raw), "from openhands_cli.entrypoint import main") {
			return false
		}
	}
	root := filepath.Dir(filepath.Dir(resolved))
	sites, _ := filepath.Glob(filepath.Join(root, "lib", "python*", "site-packages"))
	sites = append(sites, filepath.Join(root, "Lib", "site-packages"))
	for _, site := range sites {
		if !installExists(filepath.Join(site, "openhands_cli", "entrypoint.py")) {
			continue
		}
		metadata, _ := filepath.Glob(filepath.Join(site, "openhands-*.dist-info"))
		for _, dir := range metadata {
			raw, err := installReadFingerprint(filepath.Join(dir, "METADATA"))
			if err != nil || !strings.Contains("\n"+strings.ReplaceAll(string(raw), "\r\n", "\n"), "\nName: openhands\n") {
				continue
			}
			entry, err := installReadFingerprint(filepath.Join(dir, "entry_points.txt"))
			if err == nil && strings.Contains(string(entry), "[console_scripts]") {
				for _, line := range strings.Split(string(entry), "\n") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 && strings.TrimSpace(parts[0]) == "openhands" && strings.TrimSpace(parts[1]) == "openhands_cli.entrypoint:main" {
						return true
					}
				}
			}
		}
	}
	return false
}

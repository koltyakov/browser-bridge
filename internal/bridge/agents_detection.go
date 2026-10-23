package bridge

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Passive installation hints only. Never execute a discovered program, inspect
// credentials, or infer an installed agent from a retained settings directory.
// These fingerprints do not identify or authorize an active MCP caller.
func installAdditionalAgentDetected(target string, scope installScope) bool {
	if target == "cline" && installClineExtensionDetected(scope) {
		return true
	}
	if target == "zed" {
		return installZedDetected(scope)
	}
	if path, err := exec.LookPath(target); err == nil && installAgentPackageMatches(path, target) {
		return true
	}
	// Native installers have no npm manifest. Require an executable in their
	// documented installation tree, not an arbitrary PATH basename such as the
	// unrelated Homebrew text editor called amp.
	var paths []string
	switch target {
	case "amp":
		home := os.Getenv("AMP_HOME")
		if home == "" {
			home = filepath.Join(scope.home, ".amp")
		}
		paths = []string{filepath.Join(home, "bin", "amp")}
	case "droid":
		paths = []string{filepath.Join(scope.home, ".local", "bin", "droid")}
		if runtime.GOOS == "windows" {
			paths = []string{filepath.Join(scope.home, "bin", "droid")}
		}
	}
	for _, path := range paths {
		if runtime.GOOS == "windows" {
			path += ".exe"
		}
		if installExecutableExists(path) {
			return true
		}
	}
	return false
}

func installExecutableExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && (runtime.GOOS == "windows" || info.Mode().Perm()&0111 != 0)
}

func installReadFingerprint(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, 256*1024))
}

type installAgentPackage struct {
	Name                 string            `json:"name"`
	Publisher            string            `json:"publisher"`
	Main                 string            `json:"main"`
	Dependencies         map[string]string `json:"dependencies"`
	OptionalDependencies map[string]string `json:"optionalDependencies"`
}

func installPackageMatches(manifest, target string) bool {
	data, err := installReadFingerprint(manifest)
	if err != nil {
		return false
	}
	var pkg installAgentPackage
	if json.Unmarshal(data, &pkg) != nil {
		return false
	}
	switch target {
	case "gemini":
		return pkg.Name == "@google/gemini-cli"
	case "cline":
		return pkg.Name == "cline" || pkg.Name == "@cline/cli"
	case "amp":
		return pkg.Name == "@ampcode/cli" || strings.HasPrefix(pkg.Name, "@ampcode/cli-") || pkg.Name == "@sourcegraph/amp"
	case "droid":
		if strings.HasPrefix(pkg.Name, "@factory/cli-") {
			return true
		}
		if pkg.Name == "droid" {
			for _, dependencies := range []map[string]string{pkg.Dependencies, pkg.OptionalDependencies} {
				for name := range dependencies {
					if strings.HasPrefix(name, "@factory/cli-") {
						return true
					}
				}
			}
		}
	}
	return false
}

func installAgentPackageMatches(path, target string) bool {
	if !installExecutableExists(path) {
		return false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	dir := filepath.Dir(resolved)
	for depth := 0; depth < 8; depth++ {
		if installPackageMatches(filepath.Join(dir, "package.json"), target) {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	// npm's Windows .cmd launchers sit next to node_modules instead of inside
	// the package. Corroborate the shim reference with that package's manifest.
	shim, err := installReadFingerprint(path)
	if err != nil {
		return false
	}
	normalized := strings.ReplaceAll(string(shim), "\\", "/")
	packages := map[string][]string{
		"gemini": {"@google/gemini-cli"}, "cline": {"cline"},
		"amp": {"@ampcode/cli", "@sourcegraph/amp"}, "droid": {"droid"},
	}
	for _, name := range packages[target] {
		if strings.Contains(normalized, "node_modules/"+name+"/") && installPackageMatches(filepath.Join(filepath.Dir(path), "node_modules", filepath.FromSlash(name), "package.json"), target) {
			return true
		}
	}
	return false
}

func installClineExtensionDetected(scope installScope) bool {
	for _, editor := range []string{".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".devin", ".windsurf"} {
		root := filepath.Join(scope.home, editor, "extensions")
		obsolete := map[string]bool{}
		if raw, err := installReadFingerprint(filepath.Join(root, ".obsolete")); err == nil {
			if json.Unmarshal(raw, &obsolete) != nil {
				continue
			}
		}
		entries, _ := os.ReadDir(root)
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "saoudrizwan.claude-dev-") || obsolete[entry.Name()] {
				continue
			}
			dir := filepath.Join(root, entry.Name())
			raw, err := installReadFingerprint(filepath.Join(dir, "package.json"))
			var pkg installAgentPackage
			if err != nil || json.Unmarshal(raw, &pkg) != nil || pkg.Publisher != "saoudrizwan" || pkg.Name != "claude-dev" || pkg.Main == "" {
				continue
			}
			main := filepath.Clean(filepath.FromSlash(pkg.Main))
			if filepath.IsAbs(main) || main == ".." || strings.HasPrefix(main, ".."+string(filepath.Separator)) {
				continue
			}
			if info, err := os.Stat(filepath.Join(dir, main)); err == nil && info.Mode().IsRegular() {
				return true
			}
		}
	}
	return false
}

func installZedDetected(scope installScope) bool {
	if runtime.GOOS == "darwin" {
		for _, root := range []string{"/Applications", filepath.Join(scope.home, "Applications")} {
			for _, app := range []string{"Zed.app", "Zed Preview.app"} {
				bundle := filepath.Join(root, app, "Contents")
				if !installExecutableExists(filepath.Join(bundle, "MacOS", "zed")) {
					continue
				}
				plist, err := installReadFingerprint(filepath.Join(bundle, "Info.plist"))
				if err == nil && (strings.Contains(string(plist), "<string>dev.zed.Zed</string>") || strings.Contains(string(plist), "<string>dev.zed.Zed-Preview</string>")) {
					return true
				}
			}
		}
	}
	if runtime.GOOS == "linux" {
		for _, app := range []string{"zed.app", "zed-preview.app"} {
			if installExecutableExists(filepath.Join(scope.home, ".local", app, "libexec", "zed-editor")) {
				return true
			}
		}
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(scope.home, "AppData", "Local")
		}
		if installExecutableExists(filepath.Join(base, "Programs", "Zed", "Zed.exe")) {
			return true
		}
	}
	// Distro/custom launchers need corroborating application metadata. Their
	// shared .config/zed directory, terminal markers, or name alone don't count.
	if path, err := exec.LookPath("zed"); err == nil && installExecutableExists(path) && runtime.GOOS == "linux" {
		for _, root := range []string{filepath.Join(scope.home, ".local", "share"), "/usr/share", "/usr/local/share"} {
			data, err := installReadFingerprint(filepath.Join(root, "applications", "dev.zed.Zed.desktop"))
			if err == nil && strings.Contains(string(data), "Exec=") && strings.Contains(string(data), "zed") {
				return true
			}
		}
	}
	return false
}

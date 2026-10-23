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

type installExtensionIdentity struct {
	publisher string
	name      string
}

type installAgentPresence struct {
	// Legacy agents retain their existing weak directory/PATH hints. New
	// agents use passive package/payload evidence, never credential inspection.
	legacy             bool
	commands           []string
	homeHints          []string
	apps               []string
	packages           []string
	packagePrefixes    []string
	dependencyPrefixes []string
	extension          installExtensionIdentity
	nativePaths        func(installScope) []string
	nativeMatch        func(string) bool
	pathMatch          func(string) bool
	detect             func(installScope) bool
}

// Presence is a setup hint, not active-caller identity or authorization. All
// fingerprints are passive. No discovered program or installer is executed.
func installPresenceDetected(agent *installAgentDefinition, scope installScope) bool {
	presence := agent.presence
	if presence.detect != nil && presence.detect(scope) {
		return true
	}
	if presence.extension.name != "" && installEditorExtensionDetected(scope, presence.extension.publisher, presence.extension.name) {
		return true
	}
	for _, command := range presence.commands {
		if path, err := exec.LookPath(command); err == nil {
			if presence.legacy || (presence.pathMatch != nil && presence.pathMatch(path)) || installAgentPackageMatches(path, agent.key) {
				return true
			}
		}
	}
	if presence.nativePaths != nil {
		for _, path := range presence.nativePaths(scope) {
			if installExecutableExists(path) && (presence.nativeMatch == nil || presence.nativeMatch(path)) {
				return true
			}
		}
	}
	if presence.legacy {
		for _, path := range presence.homeHints {
			if installExists(filepath.Join(scope.home, filepath.FromSlash(path))) {
				return true
			}
		}
		if runtime.GOOS == "darwin" {
			for _, app := range presence.apps {
				if installExists(filepath.Join("/Applications", app)) || installExists(filepath.Join(scope.home, "Applications", app)) {
					return true
				}
			}
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
	defer func() { _ = file.Close() }()
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
	agent := installAgentByKey(target)
	if agent == nil {
		return false
	}
	data, err := installReadFingerprint(manifest)
	if err != nil {
		return false
	}
	var pkg installAgentPackage
	if json.Unmarshal(data, &pkg) != nil {
		return false
	}
	presence := agent.presence
	for _, prefix := range presence.packagePrefixes {
		if strings.HasPrefix(pkg.Name, prefix) {
			return true
		}
	}
	if installContains(presence.packages, pkg.Name) {
		if len(presence.dependencyPrefixes) > 0 {
			for _, dependencies := range []map[string]string{pkg.Dependencies, pkg.OptionalDependencies} {
				for name := range dependencies {
					for _, prefix := range presence.dependencyPrefixes {
						if strings.HasPrefix(name, prefix) {
							return true
						}
					}
				}
			}
			return false
		}
		return true
	}
	return false
}

func installAgentPackageMatches(path, target string) bool {
	agent := installAgentByKey(target)
	if agent == nil || (len(agent.presence.packages) == 0 && len(agent.presence.packagePrefixes) == 0) || !installExecutableExists(path) {
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
	for _, name := range agent.presence.packages {
		if strings.Contains(normalized, "node_modules/"+name+"/") && installPackageMatches(filepath.Join(filepath.Dir(path), "node_modules", filepath.FromSlash(name), "package.json"), target) {
			return true
		}
	}
	return false
}

func installEditorExtensionDetected(scope installScope, publisher, name string) bool {
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
			if !entry.IsDir() || !strings.HasPrefix(entry.Name(), publisher+"."+name+"-") || obsolete[entry.Name()] {
				continue
			}
			dir := filepath.Join(root, entry.Name())
			raw, err := installReadFingerprint(filepath.Join(dir, "package.json"))
			var pkg installAgentPackage
			if err != nil || json.Unmarshal(raw, &pkg) != nil || pkg.Publisher != publisher || pkg.Name != name || pkg.Main == "" {
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

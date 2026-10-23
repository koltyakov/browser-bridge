package bridge

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func installTestExecutable(t *testing.T, path string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		path += ".exe"
	}
	installTestWrite(t, path, "fixture executable, never run\n")
	if err := os.Chmod(path, 0755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAdditionalPackageFingerprints(t *testing.T) {
	for _, test := range []struct {
		target, manifest string
	}{
		{"gemini", `{"name":"@google/gemini-cli"}`},
		{"cline", `{"name":"cline"}`},
		{"amp", `{"name":"@ampcode/cli"}`},
		{"amp", `{"name":"@ampcode/cli-darwin-arm64"}`},
		{"amp", `{"name":"@sourcegraph/amp"}`},
		{"droid", `{"name":"droid","optionalDependencies":{"@factory/cli-linux-x64":"1"}}`},
		{"droid", `{"name":"@factory/cli-darwin-arm64"}`},
		{"pi", `{"name":"@earendil-works/pi-coding-agent"}`},
		{"pi", `{"name":"@mariozechner/pi-coding-agent"}`},
		{"kilo", `{"name":"@kilocode/cli"}`},
		{"qwen", `{"name":"@qwen-code/qwen-code"}`},
		{"grok", `{"name":"@xai-official/grok"}`},
	} {
		t.Run(test.target+test.manifest, func(t *testing.T) {
			_, scope := installTestScope(t)
			pkg := filepath.Join(scope.home, "package")
			installTestWrite(t, filepath.Join(pkg, "package.json"), test.manifest)
			bin := filepath.Join(pkg, "bin")
			path := installTestExecutable(t, filepath.Join(bin, test.target))
			t.Setenv("PATH", bin)
			if !installAgentPackageMatches(path, test.target) || !installAgentDetected(test.target, scope) {
				t.Fatal("verified package/executable wasn't detected")
			}
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			if installAgentDetected(test.target, scope) {
				t.Fatal("orphaned package manifest counted as an installed CLI")
			}
		})
	}
}

func TestAdditionalDetectionRejectsRetainedFoldersAndNameCollisions(t *testing.T) {
	_, scope := installTestScope(t)
	bin := t.TempDir()
	t.Setenv("PATH", bin)
	for _, dir := range []string{".gemini", ".cline", ".config/amp", ".factory", ".config/zed", ".agents/skills"} {
		if err := os.MkdirAll(filepath.Join(scope.home, filepath.FromSlash(dir)), 0755); err != nil {
			t.Fatal(err)
		}
	}
	for _, target := range []string{"gemini", "cline", "amp", "droid", "pi", "kilo", "qwen", "goose", "openhands", "muse", "grok"} {
		if installAgentDetected(target, scope) {
			t.Fatalf("retained %s config directory counted as an installation", target)
		}
		path := installTestExecutable(t, filepath.Join(bin, target))
		if installAgentDetected(target, scope) || installAgentPackageMatches(path, target) {
			t.Fatalf("uncorroborated PATH basename counted as %s", target)
		}
	}
	// npm droid without a Factory platform dependency could be another package.
	installTestWrite(t, filepath.Join(bin, "package.json"), `{"name":"droid"}`)
	if installAgentDetected("droid", scope) {
		t.Fatal("unverified droid npm name counted as Factory")
	}
	installTestWrite(t, filepath.Join(bin, "package.json"), `{"name":"amp","description":"text editor"}`)
	if installAgentDetected("amp", scope) {
		t.Fatal("the unrelated amp editor counted as the coding agent")
	}
	for _, target := range []string{"pi", "grok", "muse"} {
		installTestWrite(t, filepath.Join(bin, "package.json"), `{"name":"`+target+`-cli"}`)
		if installAgentDetected(target, scope) {
			t.Fatal("unofficial package counted as", target)
		}
	}
}

func TestAdditionalNativeInstallFingerprints(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	ampHome := filepath.Join(scope.home, "custom-amp")
	t.Setenv("AMP_HOME", ampHome)
	amp := installTestExecutable(t, filepath.Join(ampHome, "bin", "amp"))
	if !installAgentDetected("amp", scope) {
		t.Fatal("official Amp native tree wasn't detected")
	}
	droid := filepath.Join(scope.home, ".local", "bin", "droid")
	if runtime.GOOS == "windows" {
		droid = filepath.Join(scope.home, "bin", "droid")
	}
	installTestExecutable(t, droid)
	if !installAgentDetected("droid", scope) {
		t.Fatal("official Droid native path wasn't detected")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(amp, 0644); err != nil {
			t.Fatal(err)
		}
		if installAgentDetected("amp", scope) {
			t.Fatal("non-executable native file counted as installed")
		}
	}
}

func TestClineExtensionFingerprint(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	root := filepath.Join(scope.home, ".vscode", "extensions")
	name := "saoudrizwan.claude-dev-4.0.0"
	dir := filepath.Join(root, name)
	manifest := filepath.Join(dir, "package.json")
	installTestWrite(t, manifest, `{"name":"claude-dev","publisher":"saoudrizwan","main":"dist/extension.js"}`)
	if installAgentDetected("cline", scope) {
		t.Fatal("extension manifest without entrypoint counted as installed")
	}
	installTestWrite(t, filepath.Join(dir, "dist", "extension.js"), "// extension fixture")
	if !installAgentDetected("cline", scope) {
		t.Fatal("exact installed Cline extension wasn't detected")
	}
	installTestWrite(t, filepath.Join(root, ".obsolete"), `{"`+name+`":true}`)
	if installAgentDetected("cline", scope) {
		t.Fatal("uninstalled extension directory counted as installed")
	}
	installTestWrite(t, filepath.Join(root, ".obsolete"), `{}`)
	installTestWrite(t, manifest, `{"name":"claude-dev","publisher":"other","main":"dist/extension.js"}`)
	if installAgentDetected("cline", scope) {
		t.Fatal("wrong publisher counted as Cline")
	}
}

func TestNpmShimFingerprint(t *testing.T) {
	_, scope := installTestScope(t)
	bin := filepath.Join(scope.home, "npm")
	shim := filepath.Join(bin, "gemini.cmd")
	installTestWrite(t, shim, `@node "%~dp0\node_modules\@google\gemini-cli\dist\index.js" %*`)
	if err := os.Chmod(shim, 0755); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(bin, "node_modules", "@google", "gemini-cli", "package.json")
	installTestWrite(t, manifest, `{"name":"@google/gemini-cli"}`)
	if !installAgentPackageMatches(shim, "gemini") {
		t.Fatal("corroborated npm Windows shim wasn't detected")
	}
	installTestWrite(t, manifest, `{"name":"other"}`)
	if installAgentPackageMatches(shim, "gemini") {
		t.Fatal("shim text without matching manifest counted as Gemini")
	}
}

func TestZedNativeFingerprint(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	switch runtime.GOOS {
	case "darwin":
		bundle := filepath.Join(scope.home, "Applications", "Zed.app", "Contents")
		installTestExecutable(t, filepath.Join(bundle, "MacOS", "zed"))
		installTestWrite(t, filepath.Join(bundle, "Info.plist"), `<plist><dict><key>CFBundleIdentifier</key><string>dev.zed.Zed</string></dict></plist>`)
	case "linux":
		installTestExecutable(t, filepath.Join(scope.home, ".local", "zed.app", "libexec", "zed-editor"))
	case "windows":
		installTestExecutable(t, filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Zed", "Zed"))
	default:
		t.Skip("no researched native Zed layout for this platform")
	}
	if !installAgentDetected("zed", scope) {
		t.Fatal("Zed's application tree wasn't detected")
	}
}

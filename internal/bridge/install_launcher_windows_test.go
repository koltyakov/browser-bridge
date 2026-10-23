package bridge

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsLauncherPreservesSpecialPathsWithDelayedExpansion(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "100% & literal!value!")
	if err := os.MkdirAll(home, 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BROWSER_BRIDGE_HOME", home)
	probe := filepath.Join(home, "probe.cmd")
	if err := os.WriteFile(probe, []byte("@echo off\r\nset BROWSER_BRIDGE_HOME\r\nexit /b 0\r\n"), 0644); err != nil {
		t.Fatal(err)
	}
	_, body := installLauncher(config{home: home}, probe)
	// Start from a plain path so the *parent* shell does not expand the name
	// before the launcher's own setlocal command can protect its contents.
	if err := os.WriteFile(filepath.Join(root, "launcher.cmd"), body, 0644); err != nil {
		t.Fatal(err)
	}
	command := exec.Command("cmd.exe", "/d", "/v:on", "/q")
	command.Dir = root
	command.Stdin = strings.NewReader("launcher.cmd\r\nexit\r\n")
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "BROWSER_BRIDGE_HOME="+home) {
		t.Fatalf("launcher corrupted a special path: %v\n%s", err, output)
	}
}

func TestWindowsAliasesDisableDelayedExpansion(t *testing.T) {
	bin := t.TempDir()
	for _, alias := range []string{"bbx-mcp", "bbx-daemon", "bbx-install"} {
		if err := installSelfAlias(bin, alias); err != nil {
			t.Fatal(err)
		}
		body, err := os.ReadFile(filepath.Join(bin, alias+".cmd"))
		if err != nil || !strings.Contains(string(body), "setlocal DisableDelayedExpansion\r\n\"%~dp0bbx.exe\"") {
			t.Fatalf("unprotected alias %s: %s, %v", alias, body, err)
		}
	}
}

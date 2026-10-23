package bridge

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const installSelfUsage = "usage: bbx install-self [--bin-dir <directory>] [--no-restart]"

func installSelfCommand(ctx context.Context, c config, args []string) error {
	binDir := ""
	restart, finish := true, false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--bin-dir":
			if binDir != "" || i+1 == len(args) || strings.HasPrefix(args[i+1], "--") || strings.TrimSpace(args[i+1]) == "" {
				return errors.New(installSelfUsage)
			}
			i++
			binDir = args[i]
		case "--no-restart":
			restart = false
		case "--finish":
			// The installed executable owns registration and daemon startup.
			finish = true
		default:
			return errors.New(installSelfUsage)
		}
	}
	if finish {
		if binDir != "" {
			return errors.New(installSelfUsage)
		}
		return installSelfFinish(ctx, c, restart)
	}
	if binDir == "" {
		home, err := installUserHome()
		if err != nil {
			return err
		}
		binDir = filepath.Join(home, ".local", "bin")
	}
	binDir, err := filepath.Abs(binDir)
	if err != nil {
		return err
	}
	source, err := os.Executable()
	if err != nil {
		return err
	}
	installed, err := installSelfFiles(source, binDir)
	if err != nil {
		return err
	}
	childArgs := []string{"install-self", "--finish"}
	if !restart {
		childArgs = append(childArgs, "--no-restart")
	}
	child := exec.CommandContext(ctx, installed, childArgs...)
	child.Env = installSelfEnvironment(os.Environ())
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	return child.Run()
}

func installSelfEnvironment(env []string) []string {
	clean := make([]string, 0, len(env)+1)
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(key) {
		case "BBX_NPM_VERSION", "BBX_AUTO_UPDATE", "BBX_REMOTE":
			continue
		}
		clean = append(clean, entry)
	}
	return append(clean, "BBX_AUTO_UPDATE=off")
}

// Unlike config-file writes, executable installation replaces the directory
// entry itself. Following an npm symlink would overwrite the package's wrapper.
func installSelfDestination(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
		return fmt.Errorf("refusing to replace non-file %s", path)
	}
	return nil
}

func installSelfCopy(source, destination string) error {
	if err := installSelfDestination(destination); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { _ = input.Close() }()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("executable is not a regular file: %s", source)
	}
	output, err := os.CreateTemp(filepath.Dir(destination), ".bbx-install-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(output.Name()) }()
	if _, err = io.Copy(output, input); err == nil {
		err = output.Chmod(0755)
	}
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return installSelfReplace(output.Name(), destination)
}

func installSelfFiles(source, binDir string) (string, error) {
	if err := os.MkdirAll(binDir, 0755); err != nil {
		return "", err
	}
	name := "bbx"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	installed := filepath.Join(binDir, name)
	if err := installSelfCopy(source, installed); err != nil {
		return "", err
	}
	for _, alias := range []string{"bbx-mcp", "bbx-daemon", "bbx-install"} {
		if err := installSelfAlias(binDir, alias); err != nil {
			return "", err
		}
	}
	return installed, updateSyncDirectory(binDir)
}

func installSelfAlias(binDir, alias string) error {
	name := alias
	if runtime.GOOS == "windows" {
		name += ".cmd"
	}
	destination := filepath.Join(binDir, name)
	if err := installSelfDestination(destination); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(binDir, ".bbx-alias-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	temporary := filepath.Join(dir, name)
	if runtime.GOOS == "windows" {
		role := map[string]string{"bbx-mcp": "mcp serve", "bbx-daemon": "--bridge-daemon", "bbx-install": "install"}[alias]
		err = os.WriteFile(temporary, []byte("@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"%~dp0bbx.exe\" "+role+" %*\r\n"), 0644)
	} else {
		err = os.Symlink("bbx", temporary)
	}
	if err != nil {
		return err
	}
	return installSelfReplace(temporary, destination)
}

// Keep signed releases, proofs, the previous selection, and anti-rollback
// watermarks. Only the active selection must yield to this explicit install.
func installSelfClearSelection(ctx context.Context, c config) (bool, error) {
	root := filepath.Join(c.home, "native-update")
	if _, err := os.Lstat(filepath.Join(root, "state.json")); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	unlock, err := updateAcquireLock(ctx, root)
	if err != nil {
		return false, err
	}
	defer unlock()
	state, err := updateLoadState(root)
	if err != nil || state.Current == nil && state.RollbackFrom == "" {
		return false, err
	}
	backup, err := os.ReadFile(filepath.Join(root, "state.json"))
	if err != nil {
		return false, err
	}
	if err := updateAtomicWrite(filepath.Join(root, "state.before-install-self.json"), backup, 0600); err != nil {
		return false, err
	}
	state.Current, state.RollbackFrom = nil, ""
	return true, updateSaveState(root, state)
}

func installSelfFinish(ctx context.Context, c config, restart bool) error {
	// Also enforce this for direct invocation of the internal continuation.
	if err := os.Unsetenv("BBX_NPM_VERSION"); err != nil {
		return err
	}
	if err := os.Setenv("BBX_AUTO_UPDATE", "off"); err != nil {
		return err
	}
	cleared, err := installSelfClearSelection(ctx, c)
	if err != nil {
		return err
	}
	home, err := installUserHome()
	if err != nil {
		return err
	}
	browsers := []string{}
	for _, browser := range installBrowsers {
		path := filepath.Join(installManifestDir(runtime.GOOS, home, browser, os.Getenv), hostName+".json")
		if _, err := os.Lstat(path); err == nil {
			browsers = append(browsers, browser)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if len(browsers) == 0 {
		browsers = append(browsers, installDefaultBrowser())
	}
	registrations := []object{}
	for _, browser := range browsers {
		result, err := installNativeRegistration(ctx, c, browser, "", true)
		if err != nil {
			return err
		}
		result["browser"] = value(browser)
		registrations = append(registrations, result)
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	evidence := object{"executable": value(executable), "nativeRegistrations": value(registrations), "nativeUpdateSelectionCleared": value(cleared), "restartSkipped": value(!restart)}
	summary := "Browser Bridge installed."
	ok := true
	if restart {
		running, err := stopLocalDaemon(ctx, c)
		if err != nil {
			return err
		}
		pid, err := startLocalDaemon(ctx, c)
		if err != nil {
			return err
		}
		mcp, err := restartMCPProcesses(c)
		if err != nil {
			return err
		}
		evidence["previouslyRunning"], evidence["pid"], evidence["mcpProcesses"] = value(running), value(pid), value(mcp)
		ok = mcp.number("restartFailed") == 0
		summary = "Browser Bridge installed and daemon restarted. Native hosts reconnect through the updated launcher. MCP restart requests require the agent host to reconnect."
	}
	if err := printJSON(object{"ok": value(ok), "summary": value(summary), "evidence": value(evidence)}); err != nil {
		return err
	}
	if !ok {
		return cliPrintedError{}
	}
	return nil
}

package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var installExtensionPattern = regexp.MustCompile(`^[a-z]{32}$`)

func installContains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func installExists(path string) bool { _, err := os.Stat(path); return err == nil }

func installDefaultBrowser() string {
	if runtime.GOOS == "linux" {
		return "chromium"
	}
	return "chrome"
}

func installUserHome() (string, error) { return os.UserHomeDir() }

// Platform and environment arguments keep path rules testable without touching
// a browser profile on the machine running the tests.
func installManifestDir(platform, home, browser string, env func(string) string) string {
	definition := installBrowserByKey(browser)
	if definition == nil {
		return ""
	}
	var base, sub string
	switch platform {
	case "darwin":
		base = filepath.Join(home, "Library", "Application Support")
		sub = definition.macDir
	case "windows":
		base = env("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		sub = definition.windowsDir
	default:
		base = env("CHROME_CONFIG_HOME")
		if base == "" {
			base = env("XDG_CONFIG_HOME")
		}
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		sub = definition.linuxDir
		snap := filepath.Join(home, "snap", "chromium", "common", "chromium")
		if browser == "chromium" && env("CHROME_CONFIG_HOME") == "" && env("XDG_CONFIG_HOME") == "" && installExists(snap) {
			return filepath.Join(snap, "NativeMessagingHosts")
		}
	}
	return filepath.Join(base, filepath.FromSlash(sub), "NativeMessagingHosts")
}

func installRegistryKey(browser string) string {
	definition := installBrowserByKey(browser)
	if definition == nil {
		return ""
	}
	return `HKCU\Software\` + definition.registry + `\NativeMessagingHosts\` + hostName
}

func installRegistry(ctx context.Context, args ...string) error {
	program := "reg.exe"
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = os.Getenv("WINDIR")
	}
	if root != "" {
		program = filepath.Join(root, "System32", "reg.exe")
	}
	output, err := exec.CommandContext(ctx, program, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("registry: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func installParseExtensionID(input string) (string, error) {
	id := input
	if strings.HasPrefix(id, "chrome-extension://") {
		id = strings.TrimSuffix(strings.TrimPrefix(id, "chrome-extension://"), "/")
	}
	if !installExtensionPattern.MatchString(id) {
		return "", fmt.Errorf("invalid extension ID %q: expected 32 lowercase letters or chrome-extension://<id>/", input)
	}
	return id, nil
}

// Resolve the destination rather than replacing a symlink to a user's config.
// This also supports dangling links used by dotfile managers.
func installResolveFile(path string) (string, error) {
	for depth := 0; depth < 40; depth++ {
		info, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			return path, nil
		}
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return path, nil
		}
		target, err := os.Readlink(path)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		path = target
	}
	return "", fmt.Errorf("too many symlinks resolving %s", path)
}

func installAtomicWrite(path string, data []byte, mode os.FileMode) error {
	resolved, err := installResolveFile(path)
	if err != nil {
		return err
	}
	if info, statErr := os.Stat(resolved); statErr == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to replace non-file %s", path)
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(resolved), ".browser-bridge-*")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer func() { _ = os.Remove(temporary) }()
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temporary, resolved)
}

func installShellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

func installLauncher(c config, executable string) (string, []byte) {
	if runtime.GOOS == "windows" {
		// Percent signs expand even inside cmd.exe double quotes.
		escape := func(s string) string { return strings.ReplaceAll(s, "%", "%%") }
		body := "@echo off\r\nsetlocal\r\n"
		// An explicit bridge home selects an isolated named pipe on Windows.
		// Do not turn the default TCP installation into that mode implicitly.
		if os.Getenv("BROWSER_BRIDGE_HOME") != "" {
			body += "set \"BROWSER_BRIDGE_HOME=" + escape(c.home) + "\"\r\n"
		}
		for _, key := range []string{"BBX_TCP_PORT", "BBX_TCP_HOST", "BBX_TCP_BIND_HOST", "BBX_NPM_VERSION"} {
			if v := os.Getenv(key); v != "" {
				body += "set \"" + key + "=" + escape(v) + "\"\r\n"
			}
		}
		body += "\"" + escape(executable) + "\" --native-host %*\r\n"
		return filepath.Join(c.home, "native-host-launcher.cmd"), []byte(body)
	}
	body := "#!/bin/sh\nexport BROWSER_BRIDGE_HOME=" + installShellQuote(c.home) + "\n"
	for _, key := range []string{"BBX_TCP_PORT", "BBX_TCP_HOST", "BBX_TCP_BIND_HOST", "BBX_NPM_VERSION"} {
		if v := os.Getenv(key); v != "" {
			body += "export " + key + "=" + installShellQuote(v) + "\n"
		}
	}
	body += "exec " + installShellQuote(executable) + " --native-host \"$@\"\n"
	return filepath.Join(c.home, "native-host-launcher.sh"), []byte(body)
}

func installNativeRegistration(ctx context.Context, c config, browser, extensionID string, preserveOrigins bool) (object, error) {
	if !installContains(installBrowsers, browser) {
		return nil, fmt.Errorf("unsupported browser %q", browser)
	}
	home, err := installUserHome()
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	manifestPath := filepath.Join(installManifestDir(runtime.GOOS, home, browser, os.Getenv), hostName+".json")
	manifest := object{}
	if data, readErr := os.ReadFile(manifestPath); readErr == nil {
		manifest, err = decodeObject(data)
		if err != nil {
			return nil, fmt.Errorf("cannot update invalid manifest %s: %w", manifestPath, err)
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return nil, readErr
	}
	explicit := extensionID != ""
	if !explicit {
		if fromEnv, exists := os.LookupEnv("BROWSER_BRIDGE_EXTENSION_ID"); exists {
			extensionID = fromEnv
			explicit = true
		} else {
			extensionID = publishedExtensionID
		}
	}
	extensionID, err = installParseExtensionID(extensionID)
	if err != nil {
		return nil, err
	}
	origins := []string{"chrome-extension://" + extensionID + "/"}
	var existingOrigins []string
	if raw, exists := manifest["allowed_origins"]; exists {
		if err := json.Unmarshal(raw, &existingOrigins); err != nil {
			return nil, fmt.Errorf("invalid allowed_origins in %s: %w", manifestPath, err)
		}
	}
	if len(existingOrigins) > 0 && (!explicit || preserveOrigins) {
		origins = existingOrigins
		for _, origin := range origins {
			if id, parseErr := installParseExtensionID(origin); parseErr == nil {
				extensionID = id
				break
			}
		}
	}
	launcherPath, launcher := installLauncher(c, executable)
	manifest["name"], manifest["description"] = value(hostName), value("Browser Bridge native host")
	manifest["path"], manifest["type"], manifest["allowed_origins"] = value(launcherPath), value("stdio"), value(origins)
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := installAtomicWrite(launcherPath, launcher, 0755); err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(launcherPath, 0755); err != nil {
			return nil, err
		}
	}
	if err := installAtomicWrite(manifestPath, append(data, '\n'), 0644); err != nil {
		return nil, err
	}
	if runtime.GOOS == "windows" {
		if err := installRegistry(ctx, "add", installRegistryKey(browser), "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"); err != nil {
			return nil, err
		}
	}
	return object{"manifestPath": value(manifestPath), "launcherPath": value(launcherPath), "allowedOrigins": value(origins), "extensionId": value(extensionID)}, nil
}

func uninstallNativeRegistration(ctx context.Context, browser string) ([]string, error) {
	home, err := installUserHome()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(installManifestDir(runtime.GOOS, home, browser, os.Getenv), hostName+".json")
	removed := []string{}
	if err := os.Remove(path); err == nil {
		removed = append(removed, path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if runtime.GOOS == "windows" {
		// Query first: deleting an absent key is a successful no-op, while a
		// failure deleting an existing key must be reported.
		if err := installRegistry(ctx, "query", installRegistryKey(browser), "/ve"); err == nil {
			if err := installRegistry(ctx, "delete", installRegistryKey(browser), "/f"); err != nil {
				return removed, err
			}
		}
	}
	return removed, nil
}

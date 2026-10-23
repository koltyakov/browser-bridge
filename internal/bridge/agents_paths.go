package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

func installAdditionalAgent(target string) bool {
	switch target {
	case "gemini", "cline", "zed", "amp", "droid":
		return true
	}
	return false
}

func installMCPSupported(target string, scope installScope) bool {
	return installContains(installAgentNames, target) && (target != "cline" || scope.global)
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

func installAdditionalMCPPath(target string, scope installScope) (string, bool) {
	base := scope.project
	if scope.global {
		base = scope.home
	}
	switch target {
	case "gemini":
		if scope.global {
			base = installGeminiHome(scope)
		}
		return filepath.Join(base, ".gemini", "settings.json"), true
	case "cline":
		if path := os.Getenv("CLINE_MCP_SETTINGS_PATH"); path != "" {
			return path, true
		}
		data := os.Getenv("CLINE_DATA_DIR")
		if data == "" {
			data = filepath.Join(installClineHome(scope), "data")
		}
		return filepath.Join(data, "settings", "cline_mcp_settings.json"), true
	case "zed":
		if scope.global {
			return filepath.Join(installZedHome(scope), "settings.json"), true
		}
		return filepath.Join(base, ".zed", "settings.json"), true
	case "amp":
		dir := filepath.Join(base, ".amp")
		if scope.global {
			dir = filepath.Join(base, ".config", "amp")
		}
		path := filepath.Join(dir, "settings.json")
		if !installExists(path) && installExists(path+"c") {
			path += "c"
		}
		return path, true
	case "droid":
		return filepath.Join(base, ".factory", "mcp.json"), true
	}
	return "", false
}

func installValidateMCPScope(target string, scope installScope) error {
	if !installMCPSupported(target, scope) {
		return fmt.Errorf("%s supports user-scope MCP only; use --global (project CLI skills remain supported)", installAgentLabels[target])
	}
	if target == "amp" {
		path := filepath.Join(filepath.Dir(installMCPPath(target, scope)), "settings.json")
		if installExists(path) && installExists(path+"c") {
			return fmt.Errorf("both %s and %s exist; select one Amp settings file before installing", path, path+"c")
		}
	}
	return nil
}

// Resolve existing parent symlinks too, including dotfile-manager layouts whose
// final skill/config destination has not been created yet.
func installCanonicalDestination(path string) (string, error) {
	resolved, err := installResolveFile(path)
	if err != nil {
		return "", err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(resolved)
	if parent == resolved {
		return resolved, nil
	}
	canonical, err := filepath.EvalSymlinks(parent)
	if errors.Is(err, os.ErrNotExist) {
		canonical, err = installCanonicalDestination(parent)
	}
	if err != nil {
		return "", err
	}
	return filepath.Join(canonical, filepath.Base(resolved)), nil
}

func installStdioEntryKeys(raw string, entry *installJSONNode, target string, keys []string) ([]string, error) {
	transport := entry
	if nested := installJSONLookup(entry, "transport"); nested != nil {
		if target != "cline" || nested.kind != '{' {
			return nil, errors.New("existing browser-bridge transport requires manual migration to stdio")
		}
		for _, field := range []string{"command", "args", "env", "url", "httpUrl"} {
			if installJSONLookup(entry, field) != nil {
				return nil, errors.New("existing browser-bridge mixes flat and nested transports; resolve it before installing")
			}
		}
		transport = nested
		keys = append(keys, "transport")
	}
	for _, field := range []string{"url", "httpUrl", "serverUrl"} {
		if installJSONLookup(transport, field) != nil {
			return nil, errors.New("existing browser-bridge is a remote server; remove or migrate that entry explicitly before installing stdio")
		}
	}
	if command := installJSONLookup(transport, "command"); command != nil && command.kind != '"' {
		return nil, errors.New("existing browser-bridge uses a legacy command object; migrate that entry explicitly")
	}
	if kind := installJSONLookup(transport, "type"); kind != nil {
		var name string
		if json.Unmarshal([]byte(raw[kind.start:kind.end]), &name) != nil || name != "stdio" {
			return nil, errors.New("existing browser-bridge is not a stdio transport; migrate that entry explicitly")
		}
	}
	return keys, nil
}

// The Cline CLI and extension share a config and use this same exclusive lock.
// Other clients use a BBX-specific lock; unknown external writers still own
// their policy, so never break a lock or overwrite a concurrent changed file.
func installWriteMCPConfig(client, path string, scope installScope, remove bool) (bool, error) {
	resolved, err := installCanonicalDestination(path)
	if err != nil {
		return false, err
	}
	if remove && !installExists(resolved) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0755); err != nil {
		return false, err
	}
	lockPath := resolved + ".bbx.lock"
	if client == "cline" {
		lockPath = resolved + ".lock"
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err == nil {
			_ = lock.Close()
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return false, err
		}
		if time.Now().After(deadline) {
			return false, fmt.Errorf("config is locked: %s; retry when the other writer finishes", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer os.Remove(lockPath)
	data, err := os.ReadFile(resolved)
	missing := errors.Is(err, os.ErrNotExist)
	if missing {
		if remove {
			return false, nil
		}
		data = []byte("{}\n")
		if client == "codex" {
			data = nil
		}
	} else if err != nil {
		return false, err
	}
	raw := string(data)
	var updated string
	if client == "codex" {
		updated, err = installUpdateCodex(raw, remove)
	} else {
		updated, err = installUpdateJSONConfig(raw, client, path, scope, remove)
	}
	if err != nil || (remove && updated == raw) {
		return false, err
	}
	current, readErr := os.ReadFile(resolved)
	if (!missing && (readErr != nil || string(current) != raw)) || (missing && !errors.Is(readErr, os.ErrNotExist)) {
		return false, errors.New("config changed while preparing the update; retry without overwriting the other writer")
	}
	return true, installAtomicWrite(resolved, []byte(updated), 0600)
}

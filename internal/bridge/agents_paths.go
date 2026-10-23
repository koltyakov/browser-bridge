package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func installMCPSupported(target string, scope installScope) bool {
	agent := installAgentByKey(target)
	return agent != nil && (!agent.mcp.userOnly || scope.global)
}

func installValidateMCPScope(target string, scope installScope) error {
	agent := installAgentByKey(target)
	if agent == nil {
		return fmt.Errorf("unsupported MCP client %q", target)
	}
	if !installMCPSupported(target, scope) {
		return fmt.Errorf("%s supports user-scope MCP only; use --global (project CLI skills remain supported)", agent.label)
	}
	if agent.mcp.validateScope != nil {
		return agent.mcp.validateScope(scope)
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
	agent := installAgentByKey(target)
	policy := agent.mcp.transport
	if policy == installTransportLocalArray {
		if kind := installJSONLookup(entry, "type"); kind == nil || raw[kind.start:kind.end] != `"local"` {
			return nil, fmt.Errorf("existing browser-bridge is not a %s local server; migrate that entry explicitly", agent.label)
		}
		for _, field := range []string{"url", "transport", "args", "env"} {
			if installJSONLookup(entry, field) != nil {
				return nil, fmt.Errorf("existing browser-bridge mixes %s and legacy transports; migrate that entry explicitly", agent.label)
			}
		}
		if command := installJSONLookup(entry, "command"); command != nil && command.kind != '[' {
			return nil, fmt.Errorf("%s local command must be an argument array", agent.label)
		}
		return keys, nil
	}
	transport := entry
	if nested := installJSONLookup(entry, "transport"); nested != nil {
		if policy == installTransportStringStdio {
			if raw[nested.start:nested.end] != `"stdio"` {
				return nil, fmt.Errorf("existing %s browser-bridge is not stdio; migrate that entry explicitly", agent.label)
			}
		} else {
			if policy != installTransportNestedStdio || nested.kind != '{' {
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
	agent := installAgentByKey(client)
	if agent == nil {
		return false, fmt.Errorf("unsupported MCP client %q", client)
	}
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
	lockSuffix := agent.mcp.lockSuffix
	if lockSuffix == "" {
		lockSuffix = ".bbx.lock"
	}
	lockPath := resolved + lockSuffix
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
	defer func() { _ = os.Remove(lockPath) }()
	data, err := os.ReadFile(resolved)
	missing := errors.Is(err, os.ErrNotExist)
	if missing {
		if remove {
			return false, nil
		}
		data = []byte("{}\n")
		if agent.mcp.format != installConfigJSON {
			data = nil
		}
	} else if err != nil {
		return false, err
	}
	raw := string(data)
	var updated string
	if agent.mcp.validateRaw != nil && !remove {
		if err := agent.mcp.validateRaw(raw); err != nil {
			return false, err
		}
	}
	switch agent.mcp.format {
	case installConfigTOML:
		updated, err = installUpdateCodex(raw, remove)
	case installConfigYAML:
		updated, err = installUpdateGooseConfig(raw, remove)
	default:
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

package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// This is local daemon configuration, not a second bridge wire protocol.
type mcpHTTPSettings struct {
	Enabled            bool              `json:"enabled"`
	Listen             string            `json:"listen"`
	Clients            map[string]string `json:"clients"`
	IdleTimeoutSeconds int               `json:"idleTimeoutSeconds,omitempty"`
	MaxLifetimeSeconds int               `json:"maxLifetimeSeconds,omitempty"`
}

func readMCPHTTPSettings(c config) (mcpHTTPSettings, error) {
	settings := mcpHTTPSettings{Listen: "127.0.0.1:9224", IdleTimeoutSeconds: 1800, MaxLifetimeSeconds: 86400}
	data, err := os.ReadFile(filepath.Join(c.home, "mcp-http.json"))
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	if len(data) > 65536 {
		return settings, errors.New("MCP HTTP configuration exceeds 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		// Do not echo configuration values, which may contain misplaced secrets.
		return settings, errors.New("invalid MCP HTTP configuration")
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return settings, errors.New("MCP HTTP configuration must contain one object")
	}
	if !settings.Enabled {
		return settings, nil
	}
	return settings, settings.validate()
}

func (s mcpHTTPSettings) validate() error {
	host, port, err := net.SplitHostPort(s.Listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("MCP HTTP listen address must be a loopback IP and port")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 || strconv.Itoa(n) != port {
		return errors.New("invalid MCP HTTP port")
	}
	if s.IdleTimeoutSeconds < 1 || s.IdleTimeoutSeconds > 86400 || s.MaxLifetimeSeconds < s.IdleTimeoutSeconds || s.MaxLifetimeSeconds > 604800 {
		return errors.New("MCP HTTP requires an idle timeout of 1-86400 seconds and a maximum lifetime between the idle timeout and seven days")
	}
	if len(s.Clients) == 0 || len(s.Clients) > 32 {
		return errors.New("MCP HTTP requires 1-32 client credential files")
	}
	seen := make(map[string]bool)
	for name, path := range s.Clients {
		if !validID(name) || !filepath.IsAbs(path) {
			return errors.New("MCP HTTP clients require valid names and absolute credential file paths")
		}
		token, err := mcpHTTPCredential(path)
		if err != nil {
			return errors.New("MCP HTTP client credentials must be valid private token files")
		}
		if seen[token] {
			return errors.New("MCP HTTP clients must have distinct credentials")
		}
		seen[token] = true
	}
	return nil
}

func mcpHTTPCredential(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 512 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return "", errors.New("MCP HTTP token files must be private regular files")
	}
	return storedToken(path)
}

// Endpoint failure is isolated from the native bridge. No listener exists unless
// explicitly enabled, and a failed bind never falls back to another interface.
func startDaemonMCPHTTP(ctx context.Context, c config) func() {
	settings, err := readMCPHTTPSettings(c)
	if err == nil && !settings.Enabled {
		return func() {}
	}
	var server *mcpHTTPServer
	if err == nil {
		server, err = startMCPHTTP(ctx, c, settings)
	}
	instance := uniqueID()
	status := object{"pid": value(os.Getpid()), "instanceId": value(instance), "enabled": value(true), "ready": value(err == nil), "recordedAt": value(time.Now().UTC().Format(time.RFC3339))}
	if err != nil {
		status["error"] = value(err.Error())
		fmt.Fprintf(os.Stderr, "Browser Bridge MCP HTTP unavailable: %v\n", err)
	} else {
		status["url"] = value("http://" + server.listener.Addr().String() + "/mcp")
	}
	path := filepath.Join(c.home, "mcp-http-status.json")
	if writeErr := writeCLIJSON(path, status); writeErr != nil {
		fmt.Fprintf(os.Stderr, "Browser Bridge MCP HTTP status unavailable: %v\n", writeErr)
	}
	return func() {
		if server != nil {
			server.close()
		}
		if data, readErr := os.ReadFile(path); readErr == nil {
			current, _ := decodeObject(data)
			if current.text("instanceId") == instance {
				_ = os.Remove(path)
			}
		}
	}
}

func mcpHTTPStatus(c config) error {
	data, err := os.ReadFile(filepath.Join(c.home, "mcp-http-status.json"))
	if errors.Is(err, os.ErrNotExist) {
		settings, configErr := readMCPHTTPSettings(c)
		if configErr != nil {
			return configErr
		}
		return printJSON(object{"enabled": value(settings.Enabled), "ready": value(false), "summary": value("No running MCP HTTP endpoint is registered. Start bbx-daemon after configuring mcp-http.json; stdio remains available.")})
	}
	if err != nil {
		return err
	}
	status, err := decodeObject(data)
	if err != nil {
		return err
	}
	// A status file is diagnostic evidence, not proof of a live listener.
	status["summary"] = value("Recorded daemon endpoint status. Verify the authenticated endpoint before using it.")
	return printJSON(status)
}

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type endpoint struct {
	URL    string `json:"url"`
	Source string `json:"source"`
}

type isolationProof struct {
	Profile  string `json:"profile"`
	PortFile string `json:"portFile"`
}

type launchSources struct {
	root        string
	profiles    []string
	logPath     string
	logInfo     os.FileInfo
	logOffset   int64
	oldPortFile map[string]bool
}

// Capture before launching. Only appended bytes from this exact log file and
// newly created port files can identify the process launched by this runner.
func captureSources(root, logPath string, profiles []string) (launchSources, error) {
	file, err := os.Open(logPath)
	if err != nil {
		return launchSources{}, err
	}
	defer func() { _ = file.Close() }()
	// A handle captures file identity now. Windows path-based Stat defers
	// resolving identity until SameFile, when this path may name a replacement.
	info, err := file.Stat()
	if err != nil {
		return launchSources{}, err
	}
	s := launchSources{root: root, profiles: profiles, logPath: logPath, logInfo: info, logOffset: info.Size(), oldPortFile: map[string]bool{}}
	for _, profile := range profiles {
		file := filepath.Join(profile, "DevToolsActivePort")
		_, err := os.Lstat(file)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return s, err
		}
		s.oldPortFile[file] = err == nil
	}
	return s, nil
}

func parseEndpoint(value string) (string, error) {
	u, err := url.Parse(value)
	if err != nil {
		return "", errors.New("invalid DevTools endpoint")
	}
	port, portErr := strconv.Atoi(u.Port())
	id := strings.TrimPrefix(u.Path, "/devtools/browser/")
	if u.Scheme != "ws" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") ||
		portErr != nil || port < 1 || port > 65535 || strconv.Itoa(port) != u.Port() ||
		id == u.Path || id == "" || strings.ContainsAny(id, "/% \t\r\n") || u.RawPath != "" {
		return "", errors.New("DevTools endpoint must be a loopback browser WebSocket without credentials, query, or fragment")
	}
	return "ws://" + net.JoinHostPort(u.Hostname(), u.Port()) + "/devtools/browser/" + id, nil
}

func parsePortFile(data []byte) (string, error) {
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		return "", errors.New("invalid DevToolsActivePort contents")
	}
	return parseEndpoint("ws://127.0.0.1:" + strings.TrimSuffix(lines[0], "\r") + strings.TrimSuffix(lines[1], "\r"))
}

func (s launchSources) freshLogEndpoint() (string, error) {
	file, err := os.Open(s.logPath)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !os.SameFile(s.logInfo, info) || info.Size() < s.logOffset {
		return "", errors.New("startup log was replaced or truncated after launch capture")
	}
	if info.Size()-s.logOffset > 1024*1024 {
		return "", errors.New("startup log exceeded the discovery budget")
	}
	data, err := io.ReadAll(io.NewSectionReader(file, s.logOffset, info.Size()-s.logOffset))
	if err != nil {
		return "", err
	}
	found := ""
	// Ignore an incomplete final line until the writer finishes it.
	lines := strings.Split(string(data), "\n")
	for _, line := range lines[:len(lines)-1] {
		value, ok := strings.CutPrefix(strings.TrimSpace(line), "DevTools listening on ")
		if !ok {
			continue
		}
		candidate, err := parseEndpoint(value)
		if err != nil {
			return "", err
		}
		if found != "" && found != candidate {
			return "", errors.New("multiple fresh startup-log endpoints; refusing an ambiguous connection")
		}
		found = candidate
	}
	return found, nil
}

func within(root, filename string) bool {
	relative, err := filepath.Rel(root, filename)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func (s launchSources) freshPorts() (map[string]string, error) {
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, profile := range s.profiles {
		file := filepath.Join(profile, "DevToolsActivePort")
		if s.oldPortFile[file] {
			continue
		}
		resolved, err := filepath.EvalSymlinks(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !within(root, resolved) {
			return nil, errors.New("profile port file escapes the disposable run root")
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > 8192 {
			return nil, errors.New("profile port file is not a bounded regular file")
		}
		data, err := os.ReadFile(resolved)
		if err != nil {
			return nil, err
		}
		value, err := parsePortFile(data)
		if err != nil {
			// A browser may still be writing the two-line file.
			continue
		}
		result[file] = value
	}
	return result, nil
}

func waitProbe(ctx context.Context, label string, probe func() (bool, error)) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
		done, err := probe()
		if err != nil || done {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s: %w", label, ctx.Err())
		case <-ticker.C:
		}
	}
}

func (s launchSources) discover(ctx context.Context) (endpoint, error) {
	var result endpoint
	err := waitProbe(ctx, "endpoint discovery timed out", func() (bool, error) {
		value, err := s.freshLogEndpoint()
		if err != nil {
			return false, err
		}
		if value != "" {
			result = endpoint{value, "startup_log"}
			return true, nil
		}
		ports, err := s.freshPorts()
		if err != nil {
			return false, err
		}
		for _, profile := range s.profiles {
			if value := ports[filepath.Join(profile, "DevToolsActivePort")]; value != "" {
				if result.URL != "" && result.URL != value {
					return false, errors.New("multiple fresh profile endpoints")
				}
				result = endpoint{value, "port_file"}
			}
		}
		return result.URL != "", nil
	})
	return result, err
}

func (s launchSources) verifyIsolation(ctx context.Context, selected endpoint) (isolationProof, error) {
	var proof isolationProof
	err := waitProbe(ctx, "profile isolation not established", func() (bool, error) {
		ports, err := s.freshPorts()
		if err != nil {
			return false, err
		}
		for _, profile := range s.profiles {
			file := filepath.Join(profile, "DevToolsActivePort")
			if value := ports[file]; value != "" {
				if value != selected.URL {
					return false, errors.New("fresh profile port file does not match the discovered endpoint")
				}
				proof = isolationProof{profile, file}
			}
		}
		return proof.PortFile != "", nil
	})
	return proof, err
}

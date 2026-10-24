package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func daemonPID(c config) (int, error) {
	b, err := os.ReadFile(filepath.Join(c.home, "daemon.pid"))
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || pid == os.Getpid() {
		return 0, errors.New("invalid daemon PID file")
	}
	return pid, nil
}
func waitLifecycle(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(100 * time.Millisecond):
		return nil
	}
}
func stopLocalDaemon(ctx context.Context, c config) (bool, error) {
	if c.remote {
		return false, errors.New("cannot stop a remote daemon")
	}
	conn, err := c.dial()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) || isRefused(err) {
			return false, nil
		}
		return false, err
	}
	_ = conn.Close()
	// Registration authenticates without a versioned RPC. A replacement CLI
	// must be able to stop a daemon from an older protocol major version.
	conn, _, err = register(c, "agent")
	if err != nil {
		return true, err
	}
	_ = conn.Close()
	pid, err := daemonPID(c)
	if err != nil {
		return true, err
	}
	if err = terminateProcess(pid); err != nil {
		return true, err
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := c.dial()
		if err != nil && (isRefused(err) || errors.Is(err, os.ErrNotExist)) {
			return true, nil
		}
		if conn != nil {
			_ = conn.Close()
		}
		if err = waitLifecycle(ctx); err != nil {
			return true, err
		}
	}
	return true, errors.New("daemon did not stop within 5 seconds")
}
func startLocalDaemon(ctx context.Context, c config) (int, error) {
	if c.remote {
		return 0, errors.New("cannot start a remote daemon")
	}
	if err := startDaemon(c); err != nil {
		return 0, err
	}
	deadline := time.Now().Add(5 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		cl, err := connect(c, "agent")
		if err == nil {
			_, err = invokeCLI(ctx, cl, nil, "health.ping", object{})
			cl.close()
			if err == nil {
				return daemonPID(c)
			}
		}
		last = err
		if err = waitLifecycle(ctx); err != nil {
			return 0, err
		}
	}
	return 0, fmt.Errorf("daemon did not start: %w", last)
}
func restartMCPProcesses(c config) (object, error) {
	dir := filepath.Join(c.home, "mcp-processes")
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	registered, requested, failed, stale := 0, 0, 0, 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		registered++
		path := filepath.Join(dir, entry.Name())
		b, e := os.ReadFile(path)
		if e != nil {
			failed++
			continue
		}
		r, e := decodeObject(b)
		if e != nil || r.number("protocolVersion") != 1 || r.number("pid") <= 0 || r.number("port") < 1 || r.number("port") > 65535 || r.text("token") == "" || r.text("instanceId") == "" {
			if os.Remove(path) == nil {
				stale++
			} else {
				failed++
			}
			continue
		}
		conn, e := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.FormatInt(r.number("port"), 10)), time.Second)
		accepted := false
		if e == nil {
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			w := wireWriter{out: conn}
			if w.send(object{"action": value("restart"), "token": r["token"]}) == nil {
				result, e := readLine(bufio.NewReaderSize(conn, 4096))
				accepted = e == nil && result.boolean("ok")
			}
			_ = conn.Close()
		}
		if accepted {
			requested++
			_ = os.Remove(path)
		} else if isRefused(e) || !processRunning(int(r.number("pid"))) {
			// A closed control endpoint is stale even when the OS has reused its
			// recorded PID. Remove only the registration, never signal that PID.
			if os.Remove(path) == nil {
				stale++
			} else {
				failed++
			}
		} else {
			failed++
		}
	}
	return object{"registered": value(registered), "restartRequested": value(requested), "restartFailed": value(failed), "staleRegistrationsRemoved": value(stale)}, nil
}
func restartCLI(ctx context.Context, c config, args []string) error {
	if len(args) != 0 {
		return errors.New("usage: bbx restart")
	}
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
	err = printJSON(object{"ok": value(mcp.number("restartFailed") == 0), "summary": value("Browser Bridge daemon restarted."), "evidence": value(object{"previouslyRunning": value(running), "pid": value(pid), "transport": value(c.address), "mcpProcesses": value(mcp)})})
	if err != nil {
		return err
	}
	if mcp.number("restartFailed") > 0 {
		return cliPrintedError{}
	}
	return nil
}
func doctorCLI(ctx context.Context, c config, args []string) error {
	if len(args) != 0 {
		return errors.New("usage: bbx doctor")
	}
	issues := []string{}
	report := object{"runtime": value("go"), "version": value(version), "bridgeHome": value(c.home), "transport": value(c.address)}
	setup, setupErr := setupStatus(c)
	if setupErr != nil {
		issues = append(issues, "Setup diagnostics: "+setupErr.Error())
	} else {
		report["setup"] = value(setup)
	}
	warnings := []string{}
	if clients, ok := cliArray(setup["mcpClients"]); ok {
		for _, raw := range clients {
			client, _ := decodeObject(raw)
			if client.boolean("stale") {
				warnings = append(warnings, fmt.Sprintf("%s MCP config at %s launches a missing file; run `bbx install-mcp %s` to rewrite it.", client.text("label"), client.text("configPath"), client.text("key")))
			}
		}
	}
	report["warnings"] = value(warnings)
	manifests := []object{}
	validManifest := false
	if home, err := os.UserHomeDir(); err == nil {
		for _, browser := range installBrowsers {
			path := filepath.Join(installManifestDir(runtime.GOOS, home, browser, os.Getenv), hostName+".json")
			b, err := os.ReadFile(path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			entry := object{"browser": value(browser), "path": value(path)}
			manifest, parseErr := decodeObject(b)
			if err != nil {
				entry["error"] = value(err.Error())
			} else if parseErr != nil {
				entry["error"] = value(parseErr.Error())
			} else {
				entry["launcher"] = manifest["path"]
				entry["allowedOrigins"] = manifest["allowed_origins"]
				launcher := manifest.text("path")
				if manifest.text("name") != hostName || manifest.text("type") != "stdio" || launcher == "" {
					entry["error"] = value("invalid native host manifest")
				} else if _, err = os.Stat(launcher); err != nil {
					entry["error"] = value("native host launcher is missing")
				} else {
					validManifest = true
					entry["valid"] = value(true)
				}
			}
			manifests = append(manifests, entry)
		}
	}
	report["nativeManifests"] = value(manifests)
	if !validManifest {
		issues = append(issues, "Native host manifest or launcher is missing; run bbx install")
	}
	if b, err := os.ReadFile(filepath.Join(c.home, "daemon-starts.json")); err == nil {
		var starts []int64
		if json.Unmarshal(b, &starts) == nil {
			count := 0
			now := time.Now().UnixMilli()
			for _, at := range starts {
				if at <= now && now-at <= 60000 {
					count++
				}
			}
			report["daemonRestarts"] = value(object{"startsInWindow": value(count), "windowMs": value(60000), "restartLoop": value(count >= 3)})
			if count >= 3 {
				issues = append(issues, "Daemon has restarted at least three times in the last minute")
			}
		}
	}
	cl, err := connect(c, "agent")
	if err != nil {
		issues = append(issues, "Daemon unavailable: "+err.Error())
	} else {
		defer cl.close()
		health, e := invokeCLI(ctx, cl, nil, "health.ping", object{})
		if e != nil {
			issues = append(issues, e.Error())
		} else {
			report["health"] = value(health)
			if !health.boolean("extensionConnected") {
				issues = append(issues, "Browser extension is not connected")
			}
			if access := health.object("access"); access != nil && !access.boolean("enabled") {
				issues = append(issues, "Browser window access is not enabled")
			}
		}
	}
	report["issues"] = value(issues)
	summary := "Browser Bridge is ready."
	if len(warnings) > 0 {
		summary = fmt.Sprintf("Browser Bridge is ready with %d warning(s).", len(warnings))
	}
	if len(issues) > 0 {
		summary = fmt.Sprintf("Browser Bridge has %d readiness issue(s).", len(issues))
	}
	if err = printJSON(object{"ok": value(len(issues) == 0), "summary": value(summary), "evidence": value(report)}); err != nil {
		return err
	}
	if len(issues) > 0 {
		return cliPrintedError{}
	}
	return nil
}

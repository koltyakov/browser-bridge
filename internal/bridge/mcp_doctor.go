package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

var mcpDoctorVersionPattern = regexp.MustCompile(`^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$`)
var mcpDoctorExtensionPattern = regexp.MustCompile(`^[a-p]{32}$`)
var mcpDoctorProtocolPattern = regexp.MustCompile(`^(\d+)\.\d+$`)

func mcpDoctorCompatible(versions []string) bool {
	client := mcpDoctorProtocolPattern.FindStringSubmatch(protocolVersion())
	if client == nil {
		return false
	}
	for _, version := range versions {
		match := mcpDoctorProtocolPattern.FindStringSubmatch(version)
		if match != nil && match[1] == client[1] {
			return true
		}
	}
	return false
}

func mcpDoctorCount(raw json.RawMessage) int64 {
	n := mcpFloat(raw)
	if n < 0 {
		return 0
	}
	return int64(min(n, 1_000_000_000))
}
func mcpDoctorVersion(raw json.RawMessage) json.RawMessage {
	var s string
	if json.Unmarshal(raw, &s) == nil && len(s) <= 32 && mcpDoctorVersionPattern.MatchString(s) {
		return value(s)
	}
	return cliNull
}
func mcpDoctorVersions(raw json.RawMessage) []string {
	var entries []json.RawMessage
	_ = json.Unmarshal(raw, &entries)
	out := []string{}
	for _, entry := range entries {
		v := mcpDoctorVersion(entry)
		if string(v) == "null" {
			continue
		}
		var s string
		_ = json.Unmarshal(v, &s)
		if !stringIn(s, out) {
			out = append(out, s)
		}
		if len(out) == 10 {
			break
		}
	}
	return out
}
func mcpDoctorCompare(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	parse := func(parts []string, i int) int {
		if i >= len(parts) {
			return 0
		}
		s := parts[i]
		end := 0
		for end < len(s) && s[end] >= '0' && s[end] <= '9' {
			end++
		}
		n, _ := strconv.Atoi(s[:end])
		return n
	}
	for i := 0; i < max(len(left), len(right)); i++ {
		if d := parse(left, i) - parse(right, i); d != 0 {
			return d
		}
	}
	return 0
}
func mcpDoctorProtocol(health object, connected bool) object {
	daemon := mcpDoctorVersions(health["daemon_supported_versions"])
	if len(daemon) == 0 && !connected {
		daemon = mcpDoctorVersions(health["supported_versions"])
	}
	extension := []string{}
	if connected {
		if _, ok := cliArray(health["extension_supported_versions"]); ok {
			extension = mcpDoctorVersions(health["extension_supported_versions"])
		} else {
			extension = mcpDoctorVersions(health["supported_versions"])
		}
	}
	dc, ec, compatible := cliNull, cliNull, cliNull
	if len(daemon) > 0 {
		dc = value(mcpDoctorCompatible(daemon))
	}
	if len(extension) > 0 {
		ec = value(mcpDoctorCompatible(extension))
	}
	if string(dc) == "false" || string(ec) == "false" {
		compatible = value(false)
	} else if string(dc) == "true" || string(ec) == "true" {
		compatible = value(true)
	}
	migration := "unknown"
	if string(compatible) == "true" {
		migration = "none"
	}
	if string(ec) == "false" {
		migration = "update_extension"
		if mcpDoctorCompare(extension[0], protocolVersion()) > 0 {
			migration = "update_client"
		}
	} else if string(dc) == "false" {
		migration = "restart_daemon"
		if mcpDoctorCompare(daemon[0], protocolVersion()) > 0 {
			migration = "update_client"
		}
	}
	return object{"clientVersion": value(protocolVersion()), "daemonVersion": mcpDoctorVersion(health["daemonVersion"]), "daemonSupportedVersions": value(daemon), "extensionSupportedVersions": value(extension), "daemonCompatible": dc, "extensionCompatible": ec, "compatible": compatible, "migration": value(migration)}
}
func mcpDoctorDebugger(health object) object {
	d, c := health.object("debugger"), health.object("capture")
	first := func(values ...json.RawMessage) string {
		for _, v := range values {
			if v != nil && string(v) != "null" {
				var s string
				_ = json.Unmarshal(v, &s)
				return s
			}
		}
		return ""
	}
	state := first(d["state"], d["status"], health["debuggerState"])
	if !stringIn(state, []string{"idle", "active", "conflict", "detached"}) {
		state = "unknown"
	}
	if d.boolean("conflict") {
		state = "conflict"
	}
	capture := first(c["state"], d["captureState"], health["captureState"])
	if !stringIn(capture, []string{"idle", "stopped", "armed", "active", "capturing", "stop_failed", "unavailable"}) {
		capture = "unknown"
	}
	out := object{"state": value(state), "captureState": value(capture), "recentReason": cliNull}
	if reason := d.text("recentReason"); stringIn(reason, []string{"debugger_conflict", "debugger_detached", "debugger_replaced", "debugger_canceled", "target_closed"}) {
		out["recentReason"] = value(reason)
	}
	for _, key := range []string{"attachedTabCount", "heldTabCount", "pendingTabCount"} {
		out[key] = cliNull
		if mcpIsNumber(d[key]) {
			out[key] = value(mcpDoctorCount(d[key]))
		}
	}
	if tabs, ok := cliArray(d["attachedTabs"]); ok {
		out["attachedTabCount"] = value(len(tabs))
	}
	for key, source := range map[string]string{"captureActiveTabCount": "activeTabCount", "captureOwnershipCount": "ownershipCount", "captureInflightCount": "inflightCount", "interceptionActiveTabCount": "interceptionActiveTabCount", "interceptionRuleCount": "interceptionRuleCount"} {
		out[key] = cliNull
		if mcpIsNumber(c[source]) {
			out[key] = value(mcpDoctorCount(c[source]))
		}
	}
	return out
}
func mcpDoctorMetrics(metrics object) object {
	if metrics == nil {
		return nil
	}
	out := object{}
	for _, key := range strings.Fields("uptimeMs activeAgents activeExtensions pendingRequests requestsProcessed requestsFailed avgResponseTimeMs") {
		out[key] = value(mcpDoctorCount(metrics[key]))
	}
	return out
}

// mcpDoctorRecovery reports daemon recovery once, under recovery.daemon, rather
// than repeating the same snapshot inside metrics.
func mcpDoctorRecovery(health, rawMetrics object) object {
	recovery := health.object("recovery")
	daemon := normalizeRecovery(rawMetrics.object("recovery"), "daemon")
	if daemon == nil {
		daemon = normalizeRecovery(recovery.object("daemon"), "daemon")
	}
	extension := normalizeRecovery(recovery.object("routedExtension"), "routedExtension")
	loops := []string{}
	for _, kind := range recoveryKinds {
		if daemon.object("events").object(kind).boolean("activeLoop") || extension.object("events").object(kind).boolean("activeLoop") {
			loops = append(loops, kind)
		}
	}
	return object{"daemon": value(daemon), "routedExtension": value(extension), "activeLoops": value(loops)}
}
func mcpDoctorSetup(status object, source string) object {
	clients, ok := cliArray(status["mcpClients"])
	targets, targetsOK := cliArray(status["skillTargets"])
	if !ok || !targetsOK || !stringIn(status.text("scope"), []string{"global", "local"}) {
		return nil
	}
	counts := func(entries []json.RawMessage, keys []string) object {
		out := object{}
		for _, key := range keys {
			count := 0
			for _, entry := range entries[:min(100, len(entries))] {
				o, _ := decodeObject(entry)
				if o.boolean(key) {
					count++
				}
			}
			out[key] = value(count)
		}
		return out
	}
	skills := counts(targets, []string{"detected", "installed", "managed", "updateAvailable"})
	skills["updatesAvailable"] = skills["updateAvailable"]
	delete(skills, "updateAvailable")
	return object{"source": value(source), "scope": status["scope"], "mcp": value(counts(clients, []string{"detected", "configured", "stale"})), "skills": value(skills)}
}

var mcpDoctorCauses = []struct {
	cause   string
	pattern *regexp.Regexp
}{
	{"debugger_conflict", regexp.MustCompile(`(?i)another debugger|debugger.{0,40}(?:already attached|conflict|in use)`)},
	{"debugger_detached", regexp.MustCompile(`(?i)debugger.{0,40}detach|detach.{0,40}debugger`)},
	{"dialog_conflict", regexp.MustCompile(`(?i)DIALOG_ACTION_CONFLICT`)},
	{"extension_disconnected", regexp.MustCompile(`(?i)EXTENSION_DISCONNECTED|extension.{0,40}disconnect`)},
	{"wrong_window", regexp.MustCompile(`(?i)TAB_MISMATCH|wrong.{0,20}window|enabled window.{0,30}mismatch`)},
}

func mcpDoctorEvents(logs object) []object {
	var entries []json.RawMessage
	_ = json.Unmarshal(logs["entries"], &entries)
	entries = entries[max(0, len(entries)-12):]
	filtered := []object{}
	for _, raw := range entries {
		entry, err := decodeObject(raw)
		if err == nil && !stringIn(entry.text("method"), []string{"health.ping", "setup.get_status", "log.tail", "daemon.metrics"}) {
			filtered = append(filtered, entry)
		}
	}
	events := []object{}
	for _, entry := range filtered[max(0, len(filtered)-10):] {
		event := object{}
		if at, err := time.Parse(time.RFC3339Nano, entry.text("at")); err == nil {
			event["at"] = value(at.UTC().Format("2006-01-02T15:04:05.000Z"))
		}
		if _, ok := catalog.Methods[entry.text("method")]; ok {
			event["method"] = entry["method"]
		}
		if jsonBoolean(entry["ok"]) {
			event["ok"] = entry["ok"]
		}
		if stringIn(entry.text("source"), []string{"cli", "mcp"}) {
			event["source"] = entry["source"]
		}
		parts := []string{}
		for _, key := range strings.Fields("cause reason errorCode code message summary") {
			if mcpIsString(entry[key]) {
				parts = append(parts, mcpSlice(entry.text(key), 200))
			}
		}
		for _, key := range []string{"code", "message"} {
			if mcpIsString(entry.object("error")[key]) {
				parts = append(parts, mcpSlice(entry.object("error").text(key), 200))
			}
		}
		text := mcpSlice(strings.Join(parts, " "), 1000)
		for _, kind := range mcpDoctorCauses {
			if kind.pattern.MatchString(text) {
				event["cause"] = value(kind.cause)
				break
			}
		}
		if len(event) > 0 {
			events = append(events, event)
		}
	}
	return events
}

// Doctor requests bypass automatic retries and never restart a stale daemon.
func (s *mcpSession) doctor(ctx context.Context) (object, error) {
	report, installedIDs := mcpDoctorLocal(s.config)
	failures := []string{}
	_ = json.Unmarshal(report["diagnosticFailures"], &failures)
	var health, setup, logs, metrics object
	cl, connectionError := s.destinationConnectionContext(ctx, "local")
	if connectionError == nil {
		report["daemonReachable"] = value(true)
		for _, diagnostic := range []struct {
			method string
			params object
			result *object
		}{{"health.ping", object{}, &health}, {"setup.get_status", object{}, &setup}, {"log.tail", object{"limit": value(12)}, &logs}, {"daemon.metrics", object{}, &metrics}} {
			response, err := cl.request(ctx, newRequest(diagnostic.method, diagnostic.params, object{}, 0))
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if err != nil || !response.boolean("ok") {
				failures = append(failures, diagnostic.method+"_failed")
			} else {
				*diagnostic.result = response.object("result")
			}
		}
	} else {
		failures = append(failures, "daemon_connection_failed")
	}
	setupSource := "daemon"
	if !report.boolean("daemonReachable") {
		setupSource = "direct"
		var err error
		setup, err = setupStatus(s.config)
		if err != nil {
			failures = append(failures, "setup_direct_failed")
		}
	}
	if setup != nil {
		report["setup"] = value(mcpDoctorSetup(setup, setupSource))
		if string(report["setup"]) == "null" {
			failures = append(failures, "setup_status_invalid")
		}
	}
	report["diagnosticFailures"] = value(failures)
	mcpDoctorResolve(report, health, metrics, logs, connectionError, installedIDs)
	return report, nil
}

func mcpDoctorLocal(c config) (object, []string) {
	home, _ := os.UserHomeDir()
	manifestPath := filepath.Join(installManifestDir(runtime.GOOS, home, installDefaultBrowser(), os.Getenv), hostName+".json")
	browsers, manifestIssues := []object{}, []object{}
	installedIDs := []string{}
	allowedOrigins := []string{}
	installed := false
	for _, browser := range installBrowsers {
		path := filepath.Join(installManifestDir(runtime.GOOS, home, browser, os.Getenv), hostName+".json")
		data, err := os.ReadFile(path)
		exists := err == nil
		browsers = append(browsers, object{"browser": value(browser), "manifestPath": value(path), "installed": value(exists)})
		if !exists {
			continue
		}
		installed = true
		manifest, err := decodeObject(data)
		issue := func(code, message string) {
			manifestIssues = append(manifestIssues, object{"browser": value(browser), "manifestPath": value(path), "code": value(code), "message": value(message)})
		}
		if err != nil {
			issue("manifest_invalid", fmt.Sprintf("%s native host manifest is not valid JSON: %s", browser, path))
			continue
		}
		var origins []string
		_ = json.Unmarshal(manifest["allowed_origins"], &origins)
		if path == manifestPath && origins != nil {
			allowedOrigins = origins
		}
		for _, origin := range origins[:min(100, len(origins))] {
			id := strings.TrimSuffix(strings.TrimPrefix(origin, "chrome-extension://"), "/")
			if origin == "chrome-extension://"+id+"/" && mcpDoctorExtensionPattern.MatchString(id) && !stringIn(id, installedIDs) && len(installedIDs) < 100 {
				installedIDs = append(installedIDs, id)
			}
		}
		launcher := manifest.text("path")
		if launcher == "" {
			issue("launcher_missing", "Native host manifest does not point to a launcher.")
			continue
		}
		if _, err := os.Stat(launcher); err != nil {
			issue("launcher_missing", "Native host launcher is missing: "+launcher)
			continue
		}
		// Native binaries are valid launchers. For legacy Node launchers, also
		// inspect the two absolute exec targets without executing the script.
		if script, err := os.ReadFile(launcher); err == nil && len(script) < 65536 {
			for _, target := range mcpDoctorLauncherTargets(string(script)) {
				if _, err := os.Stat(target.path); err != nil {
					issue(target.code, "Native host launcher target is missing: "+target.path)
				}
			}
		}
	}
	sort.Strings(installedIDs)
	defaultID, defaultSource := value(publishedExtensionID), "built_in"
	if id, exists := os.LookupEnv("BROWSER_BRIDGE_EXTENSION_ID"); exists {
		parsed, err := installParseExtensionID(id)
		defaultID, defaultSource = value(parsed), "env"
		if err != nil {
			defaultID, defaultSource = cliNull, "invalid_env"
		}
	}
	starts := []int64{}
	if data, err := os.ReadFile(filepath.Join(c.home, "daemon-starts.json")); err == nil {
		_ = json.Unmarshal(data, &starts)
	}
	count := 0
	now := time.Now().UnixMilli()
	for _, at := range starts {
		if at <= now && now-at <= 60000 {
			count++
		}
	}
	kind := "tcp"
	credentials := "unknown"
	if c.network == "unix" {
		kind, credentials = "socket", "not_required"
	}
	failures := []string{}
	proxy, err := readProxyConfig(c)
	if err != nil {
		failures = append(failures, "proxy_config_unavailable")
	}
	remote := object{"configuredCount": value(0), "status": value("not_configured"), "credentials": value("not_configured")}
	remotes, err := readRemoteConfig(c)
	if err != nil {
		failures = append(failures, "remote_config_unavailable")
		remote["status"] = value("config_unavailable")
	} else if len(remotes.Remotes) > 0 {
		remote = object{"configuredCount": value(len(remotes.Remotes)), "status": value("not_probed_local_only"), "credentials": value("unverified")}
	}
	unwritable := []string{}
	for _, path := range []string{c.home, filepath.Join(c.home, "daemon.pid"), filepath.Join(c.home, "daemon.log"), filepath.Join(c.home, "bridge.sock")} {
		if mcpDoctorUnwritable(path) {
			unwritable = append(unwritable, path)
		}
	}
	report := object{"manifestInstalled": value(installed), "manifestPath": value(manifestPath), "allowedOrigins": value(allowedOrigins), "defaultExtensionId": value(defaultID), "defaultExtensionIdSource": value(defaultSource), "daemonReachable": value(false), "healthAvailable": value(false), "extensionConnected": value(false), "accessEnabled": value(false), "enabledWindowId": cliNull, "routeTabId": cliNull, "routeReady": value(false), "routeReason": value("access_disabled"), "daemonRestarts": value(object{"startsInWindow": value(count), "windowMs": value(60000), "restartLoop": value(count >= 3)}), "daemonLogPath": value(filepath.Join(c.home, "daemon.log")), "unwritableBridgePaths": value(unwritable), "nativeHostManifestIssues": value(manifestIssues), "issues": value([]string{}), "nextSteps": value([]string{}), "browserManifests": value(browsers), "transport": value(object{"kind": value(kind), "local": value(true), "status": value("offline"), "proxyConfigured": value(proxy != nil), "proxyExposed": cliNull, "credentials": value(credentials)}), "connections": value(object{"extensionCount": value(0), "profileCount": value(0)}), "setup": cliNull, "remoteDestinations": value(remote), "diagnosticFailures": value(failures)}
	return report, installedIDs
}

type mcpDoctorLauncherTarget struct{ path, code string }

var mcpDoctorWindowsLauncher = regexp.MustCompile(`"([^"\r\n]+)"\s+"([^"\r\n]+)"\s+%\*`)

func mcpDoctorLauncherTargets(script string) []mcpDoctorLauncherTarget {
	paths := []string{}
	if match := mcpDoctorWindowsLauncher.FindStringSubmatch(script); match != nil {
		paths = match[1:]
	} else {
		for _, line := range strings.Split(script, "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "exec ") {
				continue
			}
			line = strings.TrimSpace(strings.TrimPrefix(line, "exec "))
			for len(paths) < 2 && strings.HasPrefix(line, "'") {
				line = line[1:]
				var token strings.Builder
				for {
					end := strings.IndexByte(line, '\'')
					if end < 0 {
						return nil
					}
					token.WriteString(line[:end])
					line = line[end+1:]
					if strings.HasPrefix(line, "\\''") {
						token.WriteByte('\'')
						line = line[3:]
						continue
					}
					break
				}
				paths = append(paths, token.String())
				line = strings.TrimSpace(line)
			}
			break
		}
	}
	if len(paths) < 2 || !filepath.IsAbs(paths[0]) || !filepath.IsAbs(paths[1]) {
		return nil
	}
	return []mcpDoctorLauncherTarget{{paths[0], "node_missing"}, {paths[1], "host_missing"}}
}

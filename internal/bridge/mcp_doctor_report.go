package bridge

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

var mcpDoctorAuthentication = regexp.MustCompile(`(?i)authentication failed|access denied|invalid.{0,20}token`)

func mcpDoctorResolve(report, health, rawMetrics, logs object, connectionError error, installedIDs []string) {
	failures := []string{}
	_ = json.Unmarshal(report["diagnosticFailures"], &failures)
	authenticationFailed := connectionError != nil && mcpDoctorAuthentication.MatchString(mcpSlice(connectionError.Error(), 200))
	transport := report.object("transport")
	status, credentials := "offline", "unknown"
	if report.boolean("daemonReachable") {
		status, credentials = "reachable", "accepted"
	}
	if authenticationFailed {
		status, credentials = "authentication_failed", "rejected"
	}
	if transport.text("kind") == "socket" {
		credentials = "not_required"
	}
	transport["status"], transport["credentials"] = value(status), value(credentials)
	available := health.text("daemon") == "ok"
	report["healthAvailable"] = value(available)
	if report.boolean("daemonReachable") && !available && !stringIn("health.ping_failed", failures) {
		failures = append(failures, "health.ping_invalid")
	}
	if !available {
		health = nil
	}
	access := health.object("access")
	report["extensionConnected"], report["accessEnabled"], report["routeReady"] = value(health.boolean("extensionConnected")), value(access.boolean("enabled")), value(access.boolean("routeReady"))
	for target, source := range map[string]string{"enabledWindowId": "windowId", "routeTabId": "routeTabId"} {
		report[target] = cliNull
		if mcpIsNumber(access[source]) {
			report[target] = value(mcpDoctorCount(access[source]))
		}
	}
	reason := access.text("reason")
	if !stringIn(reason, []string{"enabled", "access_disabled", "enabled_window_missing", "no_routable_active_tab", "reconnected", "restricted_page"}) {
		reason = "access_disabled"
	}
	report["routeReason"] = value(reason)
	var connected []object
	_ = json.Unmarshal(health["connectedExtensions"], &connected)
	connected = connected[:min(100, len(connected))]
	profileCount := 0
	identityMismatch := false
	for _, extension := range connected {
		if extension.text("profileLabel") != "" {
			profileCount++
		}
		id := extension.text("browserExtensionId")
		if len(installedIDs) > 0 && mcpDoctorExtensionPattern.MatchString(id) && !stringIn(id, installedIDs) {
			identityMismatch = true
		}
	}
	metrics := mcpDoctorMetrics(rawMetrics)
	report["metrics"] = value(metrics)
	extensions := int64(len(connected))
	if extensions == 0 {
		extensions = metrics.number("activeExtensions")
		if extensions == 0 && report.boolean("extensionConnected") {
			extensions = 1
		}
	}
	if available && extensions > 0 {
		report["extensionConnected"] = value(true)
	}
	report["connections"] = value(object{"extensionCount": value(extensions), "profileCount": value(profileCount)})
	transport["proxyExposed"] = cliNull
	if enabled := health.object("proxy")["enabled"]; jsonBoolean(enabled) {
		transport["proxyExposed"] = enabled
	}
	report["transport"] = value(transport)
	protocol, debugger, recovery := mcpDoctorProtocol(health, report.boolean("extensionConnected")), mcpDoctorDebugger(health), mcpDoctorRecovery(health, metrics)
	report["protocol"], report["debugger"], report["recovery"] = value(protocol), value(debugger), value(recovery)
	events := mcpDoctorEvents(logs)
	causes := []string{}
	for _, event := range events {
		if cause := event.text("cause"); cause != "" && !stringIn(cause, causes) {
			causes = append(causes, cause)
		}
	}
	if cause := debugger.text("recentReason"); cause != "" && !stringIn(cause, causes) {
		causes = append(causes, cause)
	}
	report["recentEvents"], report["recentCauses"] = value(events), value(causes)
	unique := []string{}
	for _, failure := range failures {
		if !stringIn(failure, unique) {
			unique = append(unique, failure)
		}
	}
	report["diagnosticFailures"] = value(unique[:min(12, len(unique))])
	issues, steps := []string{}, []string{}
	add := func(issue, step string) {
		issues = append(issues, issue)
		if step != "" {
			steps = append(steps, step)
		}
	}
	if authenticationFailed {
		add("proxy_credentials_stale", "Local TCP authentication failed. Run `bbx proxy enable --rotate-token`, restart the daemon, and update configured remote clients with `bbx remote add`.")
	}
	var unwritable []string
	_ = json.Unmarshal(report["unwritableBridgePaths"], &unwritable)
	if len(unwritable) > 0 {
		add("bridge_files_not_writable", "These Browser Bridge files are not writable by the current user: "+strings.Join(unwritable, ", ")+". Fix their ownership and retry `bbx doctor`.")
	}
	var manifestIssues []object
	_ = json.Unmarshal(report["nativeHostManifestIssues"], &manifestIssues)
	if len(manifestIssues) > 0 {
		messages := []string{}
		for _, issue := range manifestIssues {
			messages = append(messages, issue.text("message"))
		}
		add("native_host_manifest_invalid", "The native host manifest or launcher is broken: "+strings.Join(messages, " ")+" Reinstall the native host with `bbx install --browser <browser>` or `bbx install --all`.")
	}
	if restarts := report.object("daemonRestarts"); restarts.boolean("restartLoop") {
		add("daemon_restart_loop", fmt.Sprintf("The bridge daemon started %d times in the last 60s. Check the daemon log for the underlying error: %s", restarts.number("startsInWindow"), report.text("daemonLogPath")))
	}
	if !report.boolean("manifestInstalled") {
		add("native_host_manifest_missing", "Run `bbx install` (or `bbx install --all` for all browsers) to install the native host manifest.")
	}
	if !report.boolean("daemonReachable") && !authenticationFailed {
		add("daemon_offline", "Run `bbx-daemon` and retry `bbx status` or `bbx doctor`.")
	}
	if report.boolean("daemonReachable") && !available {
		add("health_unavailable", "The daemon is reachable but `health.ping` did not return valid core health. Run `bbx restart`, then update the Browser Bridge CLI and extension if the health check still fails.")
	}
	if available && identityMismatch {
		add("extension_id_mismatch", "A connected Chrome extension ID is not allowed by any installed native host manifest. Reinstall the matching browser manifest with `bbx install --browser <browser>` and reload that extension.")
	}
	if available && !report.boolean("extensionConnected") {
		add("extension_disconnected", "")
		var browsers []object
		_ = json.Unmarshal(report["browserManifests"], &browsers)
		for _, browser := range browsers {
			path := strings.ReplaceAll(browser.text("manifestPath"), "\\", "/")
			if browser.boolean("installed") && browser.text("browser") == "chromium" && (strings.Contains(path, "/snap/chromium/") || strings.Contains(path, "/.var/app/org.chromium.Chromium/")) {
				add("chromium_sandboxed_native_host_limited", "Sandboxed Chromium may not be able to launch the native host. Use a non-sandboxed browser package and run `bbx install --browser <browser>`.")
				break
			}
		}
		steps = append(steps, "Open Chrome and make sure the Browser Bridge extension is installed and active. If Chrome reports a missing native host, run `bbx install --all` and reload the extension.")
	}
	if available && report.boolean("extensionConnected") && !report.boolean("accessEnabled") {
		if reason == "enabled_window_missing" {
			add(reason, "The previously enabled window no longer exists. Focus the intended Chrome window and click Enable in the Browser Bridge popup or side panel.")
		} else {
			add("access_disabled", "If a Browser Bridge call returns ACCESS_DENIED, stop requesting access. Ask the user to focus the needed Chrome window and click Enable for the needed window, then tell you when that window is ready.")
		}
	} else if available && report.boolean("extensionConnected") && !report.boolean("routeReady") {
		add(reason, "Switch to a supported page in the enabled window, or use an explicit tabId override.")
	}
	if string(protocol["compatible"]) == "false" {
		step := "Update the Browser Bridge CLI/npm package, run `bbx restart`, and retry `bbx doctor`."
		switch protocol.text("migration") {
		case "update_extension":
			step = "Update or reload the Browser Bridge extension so it supports the client protocol, then retry `bbx doctor`."
		case "restart_daemon":
			step = "Run `bbx restart` to replace the stale daemon with this installed CLI version, then retry `bbx doctor`."
		}
		add("protocol_mismatch", step)
	}
	if debugger.text("state") == "conflict" {
		add("debugger_conflict", "")
	}
	conflict := debugger.text("state") == "conflict" || stringIn("debugger_conflict", causes)
	if conflict {
		steps = append(steps, "Close DevTools or any other debugger attached to the target tab, then retry the debugger-backed Browser Bridge operation.")
	} else if debugger.text("state") == "detached" || stringIn("debugger_detached", causes) {
		steps = append(steps, "A recent debugger session detached. Keep the target tab open and retry the debugger-backed operation; close competing debuggers if detaches continue.")
	}
	if stringIn("wrong_window", causes) {
		steps = append(steps, "A recent request targeted the wrong window. Focus the intended Chrome window, click Enable there, and retry without reusing a tabId from another window.")
	}
	var loops []string
	_ = json.Unmarshal(recovery["activeLoops"], &loops)
	for _, loop := range loops {
		step := ""
		switch loop {
		case "stale_ref_recovery":
			step = "Stale-reference recovery is repeatedly failing. Re-query the target for a fresh elementRef and retry once without reusing old refs."
		case "debugger_reattach":
			if !conflict {
				step = "Debugger reattachment is repeatedly failing. Keep the tab open, close competing debuggers, and retry one debugger-backed operation."
			}
		case "content_script_reinjection":
			step = "Content-script reinjection is repeatedly failing. Reload the Browser Bridge extension and target page, then enable the window again."
		case "native_host_reconnect":
			if !authenticationFailed {
				step = "Native-host reconnects are repeatedly failing. Run `bbx restart`; for remote TCP proxy use, verify the endpoint and rotate stale credentials with `bbx proxy enable --rotate-token`."
			}
		case "automatic_mcp_retry":
			step = "Automatic MCP retries are repeatedly failing. Stop the retry loop, resolve the reported bridge readiness issue, then retry the original read once."
		case "request_outcome":
			step = "Browser requests are repeatedly failing. Inspect the first typed bridge error, narrow the request or target as directed, and retry once after correcting that specific failure."
		}
		add(loop+"_loop", step)
	}
	for i, step := range steps {
		steps[i] = sanitizeIncidentalServiceText(step)
	}
	report["issues"], report["nextSteps"] = value(issues), value(steps)
	for _, key := range []string{"manifestPath", "daemonLogPath"} {
		if path := report.text(key); path != "" {
			report[key] = value(servicePathSummary(path))
		}
	}
	for i, path := range unwritable {
		unwritable[i] = servicePathSummary(path)
	}
	report["unwritableBridgePaths"] = value(unwritable)
	for _, issue := range manifestIssues {
		issue["manifestPath"] = value(servicePathSummary(issue.text("manifestPath")))
		issue["message"] = value(sanitizeIncidentalServiceText(issue.text("message")))
	}
	report["nativeHostManifestIssues"] = value(manifestIssues)
	var browsers []object
	_ = json.Unmarshal(report["browserManifests"], &browsers)
	for _, browser := range browsers {
		browser["manifestPath"] = value(servicePathSummary(browser.text("manifestPath")))
	}
	report["browserManifests"] = value(browsers)
}

package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestMCPDoctorDiagnosticContracts(t *testing.T) {
	ready := object{"daemon": value("ok"), "daemonVersion": value("1.2.3"), "daemon_supported_versions": value([]string{protocolVersion()}), "extension_supported_versions": value([]string{protocolVersion()}), "extensionConnected": value(true), "access": value(object{"enabled": value(true), "windowId": value(4), "routeTabId": value(12), "routeReady": value(true), "reason": value("enabled")}), "connectedExtensions": value([]object{{"browserExtensionId": value(publishedExtensionID), "profileLabel": value("Work")}})}
	fixtures := []struct {
		name                  string
		health, metrics, logs object
		connection            string
	}{
		{"ready", ready, object{"activeExtensions": value(1)}, object{}, ""},
		{"untrusted diagnostics", object{"daemon": value("ok"), "daemonVersion": value("secret invalid version"), "daemon_supported_versions": value([]string{"999.0", "bad", "999.0"}), "extensionConnected": value(true), "extension_supported_versions": value([]string{"0.0"}), "access": value(object{"enabled": value(true), "routeReady": value(false), "reason": value("restricted_page"), "routeTabId": value(-3)}), "debugger": value(object{"state": value("garbage"), "conflict": value(true), "attachedTabs": value([]int{1, 2}), "heldTabCount": value(-5), "pendingTabCount": value(1e15), "recentReason": value("target_closed")}), "capture": value(object{"state": value("active"), "activeTabCount": value(3), "inflightCount": value(1.8)})}, object{"requestsFailed": value(-1), "requestsProcessed": value(1e15)}, object{"entries": value([]object{{"method": value("health.ping"), "message": value("wrong window")}, {"at": value("2026-10-22T08:00:00Z"), "method": value("dom.query"), "source": value("mcp"), "ok": value(false), "message": value("Authorization: secret. debugger already attached")}, {"method": value("fake"), "source": value("secret"), "message": value("wrong window")}})}, ""},
		{"disconnected compatible minor", object{"daemon": value("ok"), "supported_versions": value([]string{strings.Split(protocolVersion(), ".")[0] + ".999"})}, nil, nil, ""},
		{"invalid health", object{"daemon": value("wrong")}, nil, nil, ""},
		{"authentication failure", nil, nil, nil, "authentication failed"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			expected, err := decodeObject(readContractCase(t, "mcp-doctor", fixture.name))
			if err != nil {
				t.Fatal(err)
			}
			report := object{"manifestInstalled": value(true), "daemonReachable": value(fixture.connection == ""), "diagnosticFailures": value([]string{}), "unwritableBridgePaths": value([]string{}), "nativeHostManifestIssues": value([]object{}), "browserManifests": value([]object{}), "daemonRestarts": value(object{"restartLoop": value(false)}), "transport": value(object{"kind": value("tcp"), "local": value(true), "proxyConfigured": value(false)})}
			var connectionError error
			if fixture.connection != "" {
				connectionError = errors.New(fixture.connection)
				report["diagnosticFailures"] = value([]string{"daemon_connection_failed"})
			}
			mcpDoctorResolve(report, fixture.health, fixture.metrics, fixture.logs, connectionError, []string{publishedExtensionID})
			keys := "daemonReachable healthAvailable extensionConnected accessEnabled enabledWindowId routeTabId routeReady routeReason transport connections protocol debugger recovery metrics recentEvents recentCauses diagnosticFailures issues nextSteps"
			actual, want := mcpPick(report, keys), mcpPick(expected, keys)
			if !jsonEqual(value(actual), value(want)) {
				t.Fatalf("doctor differs\ngot: %s\nwant: %s", value(actual), value(want))
			}
		})
	}
}

func TestMCPResultContracts(t *testing.T) {
	fixtures := []struct {
		name, method   string
		params, result object
		failure        bool
	}{
		{"text budget", "page.get_text", object{"textBudget": value(9)}, object{"text": value("A long visible text string"), "length": value(26), "truncated": value(false)}, false},
		{"query nodes", "dom.query", object{"maxNodes": value(2)}, object{"nodes": value([]object{{"elementRef": value("a"), "tag": value("button"), "text": value("Press"), "unexpected": value("secret")}, {"elementRef": value("b"), "tag": value("p"), "text": value("Hello")}, {"elementRef": value("c")}})}, false},
		{"network evidence", "page.get_network", object{"limit": value(1)}, object{"entries": value([]object{{"url": value("https://example.com/")}, {"url": value("https://example.com/other")}}), "captureState": value("armed"), "totalEntries": value(2), "dropped": value(0)}, false},
		{"health", "health.ping", object{}, object{"daemon": value("ok"), "extensionConnected": value(false)}, false},
		{"typed error", "dom.query", object{}, object{"code": value("STALE_ELEMENT"), "message": value("The reference expired."), "details": value(object{"text": value(strings.Repeat("a", 4500))})}, true},
		{"screenshot context", "screenshot.capture_region", object{}, object{"image": value("AQID"), "rect": value(object{"x": value(1), "y": value("bad"), "width": value(12), "height": value(5), "secret": value("omit")}), "context": value(object{"text": value(strings.Repeat("x", 4500))})}, false},
		{"exact WebMCP", "webmcp.get_tool", object{}, object{"description": value(strings.Repeat("x", 4500)), "inputSchema": value(object{"type": value("object")})}, false},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			response := success("fixture", fixture.result)
			if fixture.failure {
				response["ok"] = value(false)
				response["error"] = value(fixture.result)
				response["result"] = cliNull
			}
			expected, err := decodeObject(readContractCase(t, "mcp-results", fixture.name))
			if err != nil {
				t.Fatal(err)
			}
			actual := mcpResponse(response, fixture.method, fixture.params)
			// Cost byte counts depend on object key serialization order. Compare the
			// delivered evidence, summaries, limits, and error semantics directly.
			for _, result := range []object{actual, expected} {
				structured := result.object("structuredContent")
				for _, prefix := range []string{"delivered", "summary", "transport"} {
					for _, suffix := range []string{"Bytes", "Tokens", "CostClass"} {
						delete(structured, prefix+suffix)
					}
				}
				result["structuredContent"] = value(structured)
			}
			if !jsonEqual(value(actual), value(expected)) {
				t.Fatalf("result differs\ngot: %s\nwant: %s", value(actual), value(expected))
			}
		})
	}
}

func TestMCPDoctorCollectsOptionalDiagnosticsWithoutRetry(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "health.ping" {
			return success(request.text("id"), object{"daemon": value("ok"), "extensionConnected": value(true), "access": value(object{"enabled": value(true), "routeReady": value(true), "reason": value("enabled")})})
		}
		return failure(request.text("id"), "EXTENSION_DISCONNECTED", "optional diagnostics unavailable")
	})
	s := &mcpSession{config: c}
	defer func() {
		if s.client != nil {
			s.client.close()
		}
	}()
	report, err := s.doctor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"health.ping", "setup.get_status", "log.tail", "daemon.metrics"} {
		request := <-requests
		if request.text("method") != method {
			t.Fatalf("diagnostic order differs: %s", value(request))
		}
	}
	select {
	case request := <-requests:
		t.Fatalf("doctor retried a diagnostic: %s", value(request))
	default:
	}
	if !report.boolean("healthAvailable") || !report.boolean("routeReady") {
		t.Fatalf("optional diagnostic failure discarded core health: %s", value(report))
	}
	if !jsonEqual(report["diagnosticFailures"], value([]string{"setup.get_status_failed", "log.tail_failed", "daemon.metrics_failed"})) {
		t.Fatalf("wrong diagnostic failures: %s", report["diagnosticFailures"])
	}
}

func TestMCPExtractionClearsOnlySnapshotTokenBudget(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "page.get_state" {
			return success(request.text("id"), object{"title": value("Guide")})
		}
		return success(request.text("id"), object{"html": value("<main>Useful text.</main>"), "truncated": value(false)})
	})
	s := &mcpSession{config: c}
	defer func() {
		if s.client != nil {
			s.client.close()
		}
	}()
	response, err := s.extractContent(context.Background(), object{}, object{"budgetPreset": value("quick"), "extensionId": value("selected-profile"), "tabId": value(12)}, "modern")
	if err != nil || !response.boolean("ok") {
		t.Fatalf("extract failed: %v %s", err, value(response))
	}
	state, snapshot := <-requests, <-requests
	if state.text("method") != "page.get_state" || !mcpIsNumber(state.object("meta")["token_budget"]) {
		t.Fatalf("state budget was cleared: %s", value(state))
	}
	if snapshot.text("method") != "dom.get_html" || string(snapshot.object("meta")["token_budget"]) != "null" {
		t.Fatalf("snapshot budget was retained: %s", value(snapshot))
	}
	for _, request := range []object{state, snapshot} {
		if request.number("tab_id") != 12 || request.object("meta").text("target_extension") != "selected-profile" {
			t.Fatalf("extraction lost routing: %s", value(request))
		}
	}
}

package bridge

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPerformRecoveryNeverSuggestsReplayingDispatchedSequences(t *testing.T) {
	for _, details := range []object{nil, {"completed": value(1)}, {"completed": value(0), "failedStep": value(object{"index": value(0)})}} {
		response := object{"ok": value(false), "error": value(object{
			"code": value("TIMEOUT"), "details": value(details),
			"recovery": value(object{"retry": value(true), "hint": value("Retry once"), "alternativeMethod": value("page.handle_dialog")}),
		})}
		protectResponseRecovery(response, "input.perform")
		recovery := response.object("error").object("recovery")
		if recovery.boolean("retry") || !strings.Contains(recovery.text("hint"), "do not replay") {
			t.Fatalf("unsafe perform recovery: %s", value(response))
		}
		if recovery.text("alternativeMethod") != "page.handle_dialog" {
			t.Fatal("perform recovery lost the specific alternative method")
		}
	}
	response := object{"ok": value(false), "error": value(object{
		"details":  value(object{"dispatched": value(false)}),
		"recovery": value(object{"retry": value(true)}),
	})}
	protectResponseRecovery(response, "input.perform")
	if !response.object("error").object("recovery").boolean("retry") {
		t.Fatal("an explicitly undispatched sequence lost its safe retry policy")
	}
}

func TestRecoveryTelemetryWindowLoopsAndSaturation(t *testing.T) {
	now := time.UnixMilli(1000000)
	telemetry := recoveryTelemetry{now: func() time.Time { return now }}
	for i := 0; i < 3; i++ {
		telemetry.record("request_outcome", "dom.query", false)
	}
	telemetry.record("request_outcome", "dom.query", true)
	snapshot := telemetry.snapshot("daemon")
	event := snapshot.object("events").object("request_outcome")
	if !snapshot.boolean("activeLoop") || event.number("attempts") != 4 || event.number("failures") != 3 || string(event["successRate"]) != "0.25" {
		t.Fatalf("recovery summary mismatch: %s", value(snapshot))
	}
	if strings.Contains(string(value(snapshot)), "dom.query") {
		t.Fatal("public recovery telemetry exposed grouping keys")
	}
	if normalizeRecovery(snapshot, "daemon") == nil || normalizeRecovery(snapshot, "routedExtension") != nil {
		t.Fatal("scope validation failed")
	}
	now = now.Add(61 * time.Second)
	if telemetry.snapshot("daemon").boolean("activeLoop") {
		t.Fatal("expired loop remained active")
	}
	for i := 0; i < 10001; i++ {
		telemetry.record("request_outcome", "page.get_text", true)
	}
	event = telemetry.snapshot("daemon").object("events").object("request_outcome")
	if !event.boolean("saturated") || event.number("attempts") != 10000 || event.number("successes")+event.number("failures") != 10000 || string(event["successRate"]) != "null" {
		t.Fatal("saturation exposed misleading counts/rates")
	}
	now = now.Add(306 * time.Second)
	if telemetry.snapshot("daemon").object("events").object("request_outcome").number("attempts") != 0 {
		t.Fatal("expired buckets remain in rolling summary")
	}
}

func TestRecoveryNormalizationRejectsImpossibleExtensionCounters(t *testing.T) {
	telemetry := recoveryTelemetry{}
	telemetry.record("request_outcome", "method", true)
	snapshot := telemetry.snapshot("routedExtension")
	events := snapshot.object("events")
	event := events.object("request_outcome")
	event["failures"] = value(999)
	events["request_outcome"] = value(event)
	snapshot["events"] = value(events)
	if normalizeRecovery(snapshot, "routedExtension") != nil {
		t.Fatal("impossible counts accepted")
	}
	snapshot = telemetry.snapshot("routedExtension")
	events = snapshot.object("events")
	event = events.object("request_outcome")
	event["lastEventAt"] = value(time.Now().Add(time.Hour).UnixMilli())
	events["request_outcome"] = value(event)
	snapshot["events"] = value(events)
	if normalizeRecovery(snapshot, "routedExtension") != nil {
		t.Fatal("future event accepted")
	}
}

func TestDaemonHealthAuthoritativeFieldsAndRetryTelemetry(t *testing.T) {
	d := serviceTestDaemon(t)
	d.config.network, d.config.bind, d.config.address = "tcp", "0.0.0.0:9223", "127.0.0.1:9223"
	d.recordOutcome("health.ping", nil, false)
	meta := object{"source": value("mcp"), "automatic_retry": value(object{"attempt": value(2), "reason": value("retryable_error")})}
	d.recordOutcome("dom.query", meta, false)
	forged := object{"daemonVersion": value("forged"), "socketPath": value("forged"), "connectedExtensions": value([]string{"forged"}), "protocol_version": value("999.9"), "supported_versions": value([]string{"1.2", "secret"}), "extension": value("ok"), "extensionVersion": value("1.2.3"), "unknown": value("secret"), "access": value(object{"enabled": value(true), "windowId": value(-1), "reason": value("private"), "secret": value("hidden")}), "debugger": value(object{"status": value("active"), "attachedTabCount": value(20000), "heldTabCount": value(-1), "recentReason": value("debugger_conflict")})}
	health := d.health(forged, true)
	if health.text("daemonVersion") != version || health.text("socketPath") != d.config.address || health.text("protocol_version") != protocolVersion() || health["unknown"] != nil || strings.Contains(string(value(health)), "forged") || strings.Contains(string(value(health)), "secret") || health.object("access")["windowId"] != nil || health.object("debugger").number("attachedTabCount") != 10000 || !health.object("proxy").boolean("enabled") {
		t.Fatalf("health normalization failed: %s", value(health))
	}
	events := health.object("recovery").object("daemon").object("events")
	if events.object("request_outcome").number("attempts") != 1 || events.object("automatic_mcp_retry").number("failures") != 1 {
		t.Fatal("diagnostics or retry marker incorrectly counted")
	}
	meta["automatic_retry"] = value(object{"attempt": value(2), "reason": value("retryable_error"), "extra": value(true)})
	d.recordOutcome("dom.query", meta, true)
	if d.telemetry.snapshot("daemon").object("events").object("automatic_mcp_retry").number("attempts") != 1 {
		t.Fatal("forged retry marker counted")
	}
}

func TestDaemonLogsSanitizeIncidentalDataAndBoundStorage(t *testing.T) {
	d := serviceTestDaemon(t)
	d.pushServiceLog(object{"token": value("secret"), "url": value("https://user:password@example.com/?q=private#fragment"), "filename": value("/Users/person/private/evidence.json"), "message": value("Authorization: Bearer hidden\nCookie: a=secret\nfailed /home/user/private/file.txt")})
	encoded := string(value(d.logs))
	for _, secret := range []string{"password", "private", "hidden", "a=secret", "fragment", "/Users/person", "/home/user"} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("log leaked %q: %s", secret, encoded)
		}
	}
	for i := 0; i < 210; i++ {
		d.pushServiceLog(object{"index": value(i)})
	}
	if len(d.logs) != 200 || d.logs[0].number("index") != 10 {
		t.Fatal("log ring exceeded bound or retained oldest entries")
	}
}

func TestSharedIncidentalRedactionFixtures(t *testing.T) {
	data, err := os.ReadFile("../../protocol/fixtures/incidental-redaction.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Input     string   `json:"input"`
		Forbidden []string `json:"forbidden"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		d := serviceTestDaemon(t)
		d.pushServiceLog(object{"message": value("failed " + fixture.Input), "url": value(fixture.Input)})
		for _, secret := range fixture.Forbidden {
			if strings.Contains(string(value(d.logs)), secret) {
				t.Fatalf("log retained %q for %s", secret, fixture.Input)
			}
		}
	}
}

func TestDaemonRequestMetadataNormalization(t *testing.T) {
	meta := object{"protocol_version": value(17), "token_budget": value("invalid"), "source": value("foreign"), "mcp_era": value("modern"), "automatic_retry": value(object{"attempt": value(2), "reason": value("retryable_error")}), "agent_session": value("bad session"), "custom": value("preserved")}
	normalizeDaemonRequestMeta(meta)
	if meta.text("protocol_version") != protocolVersion() || string(meta["token_budget"]) != "null" || meta.text("custom") != "preserved" {
		t.Fatal("metadata defaults changed")
	}
	for _, key := range []string{"source", "mcp_era", "automatic_retry", "agent_session"} {
		if _, exists := meta[key]; exists {
			t.Fatalf("untrusted metadata retained %s", key)
		}
	}
	meta = object{"source": value("mcp"), "mcp_era": value("modern"), "automatic_retry": value(object{"attempt": value(2), "reason": value("retryable_error")}), "agent_session": value("  session:123  "), "token_budget": value(500)}
	normalizeDaemonRequestMeta(meta)
	if meta.text("source") != "mcp" || meta.text("mcp_era") != "modern" || meta.object("automatic_retry").number("attempt") != 2 || meta.text("agent_session") != "session:123" || meta.number("token_budget") != 500 {
		t.Fatal("valid caller metadata was dropped")
	}
}

func TestDaemonHealthDropsExtensionCostEnvelope(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	d.identity(extension, object{"browserName": value("chrome"), "browserExtensionId": value("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")})
	d.identity(extension, object{"browserName": value(strings.Repeat("x", 129)), "browserExtensionId": value("invalid")})
	if extension.identity.text("browserName") != "chrome" || extension.identity["browserExtensionId"] != nil {
		t.Fatal("invalid extension identity was accepted")
	}
	d.route(agent, newRequest("health.ping", object{}, nil, 0))
	r := serviceNextMessage(t, extension).object("request")
	response := success(r.text("id"), object{"extension": value("ok")})
	response["meta"] = value(object{"method": value("forged"), "approx_tokens": value(999), "transport_cost_class": value("high")})
	d.response(extension, response)
	meta := serviceNextMessage(t, agent).object("response").object("meta")
	if len(meta) != 3 || meta.object("timing") == nil || meta.text("method") != "health.ping" || meta.text("protocol_version") != protocolVersion() {
		t.Fatal("health reconstruction retained extension cost metadata")
	}
}

func TestDaemonHealthCompactAndDiagnosticResponses(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	d.identity(extension, object{"browserName": value("chrome"), "profileLabel": value("Work")})
	telemetry := recoveryTelemetry{}
	source := object{
		"extension": value("ok"), "extensionVersion": value("1.2.3"),
		"supported_versions": value([]string{protocolVersion()}),
		"access":             value(object{"enabled": value(true), "routeReady": value(true), "routeTabId": value(12), "reason": value("enabled")}),
		"loadedBuild":        value(object{"workerId": value("12345678-1234-1234-1234-123456789abc"), "startedAt": value("2026-10-24T00:00:00Z"), "sourceDigest": value[*string](nil)}),
		"debugger":           value(object{"status": value("idle")}),
		"capture":            value(object{"state": value("stopped")}),
		"domBaselines":       value(object{"baselineCount": value(0)}),
		"recovery":           value(telemetry.snapshot("routedExtension")),
	}
	for _, params := range []object{{}, {"diagnostics": value(false)}, {"diagnostics": value(true)}} {
		diagnostics := params.boolean("diagnostics")
		d.route(agent, newRequest("health.ping", params, nil, 0))
		routed := serviceNextMessage(t, extension).object("request")
		if !jsonEqual(routed["params"], value(params)) {
			t.Fatalf("ping options changed in transit: %s", value(routed))
		}
		// Older extensions may still send their full report for compact pings.
		d.response(extension, success(routed.text("id"), source))
		response := serviceNextMessage(t, agent).object("response")
		health := response.object("result")
		if !response.boolean("ok") || health.text("daemon") != "ok" || !health.boolean("extensionConnected") || health.text("extensionVersion") != "1.2.3" || !health.object("access").boolean("routeReady") || health.object("access").number("routeTabId") != 12 || !jsonEqual(health["extension_supported_versions"], value([]string{protocolVersion()})) || !jsonEqual(health["connectedExtensions"], value(d.snapshot())) {
			t.Fatalf("ping lost core readiness or routing fields: %s", value(response))
		}
		for _, key := range []string{"loadedBuild", "debugger", "capture", "domBaselines", "recovery", "socketPath", "transport", "proxy"} {
			if (health[key] != nil) != diagnostics {
				t.Fatalf("diagnostics=%t: unexpected %s in %s", diagnostics, key, value(health))
			}
		}
		if diagnostics && health.object("recovery").object("routedExtension") == nil {
			t.Fatal("diagnostic ping lost extension recovery telemetry")
		}
		if !diagnostics && len(value(health)) > 1024 {
			t.Fatalf("compact ping exceeded 1 KiB: %s", value(health))
		}
	}
}

func TestDaemonHealthWithoutExtensionAndInvalidDiagnostics(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	for _, diagnostics := range []bool{false, true} {
		d.route(agent, newRequest("health.ping", object{"diagnostics": value(diagnostics)}, nil, 0))
		health := serviceNextMessage(t, agent).object("response").object("result")
		if health.text("daemon") != "ok" || health.boolean("extensionConnected") || !jsonEqual(health["connectedExtensions"], value([]object{})) || (health["recovery"] != nil) != diagnostics {
			t.Fatalf("disconnected health mismatch: %s", value(health))
		}
	}
	for _, invalid := range []json.RawMessage{value("true"), value(1), value(0), value[*bool](nil), value(object{}), value([]bool{})} {
		d.route(agent, newRequest("health.ping", object{"diagnostics": invalid}, nil, 0))
		response := serviceNextMessage(t, agent).object("response")
		if response.boolean("ok") || response.object("error").text("code") != "INVALID_REQUEST" {
			t.Fatalf("invalid diagnostics accepted: %s", value(response))
		}
	}
}

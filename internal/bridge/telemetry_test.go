package bridge

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

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
	health := d.health(forged)
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
	if len(meta) != 2 || meta.text("method") != "health.ping" || meta.text("protocol_version") != protocolVersion() {
		t.Fatal("health reconstruction retained extension cost metadata")
	}
}

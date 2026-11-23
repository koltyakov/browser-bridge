package bridge

import (
	"testing"
	"time"
)

func TestRequestsWaitForAReconnectingBrowser(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	old := serviceTestPeer(t, d, "extension")
	d.identity(old, object{"browserName": value("chrome")})
	d.disconnect(old)
	d.mu.Lock()
	d.route(agent, newRequest("page.get_state", nil, nil, 12))
	parked := len(d.parked)
	d.mu.Unlock()
	if parked != 1 || len(agent.out) != 0 {
		t.Fatalf("request failed instead of waiting: parked=%d queued=%d", parked, len(agent.out))
	}
	fresh := serviceTestPeer(t, d, "extension")
	d.mu.Lock()
	d.handleEnvelope(fresh, object{"type": value("extension.identity"), "browserName": value("chrome")}, nil)
	d.mu.Unlock()
	if forwarded := serviceNextMessage(t, fresh); forwarded.object("request").text("method") != "page.get_state" {
		t.Fatalf("parked request was not routed to the reconnected browser: %v", forwarded)
	}
}

func TestParkedRequestsFailWithTheRoutingErrorAtTheirDeadline(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	d.lastExtensionAt = time.Now()
	d.mu.Lock()
	request := newRequest("page.get_state", nil, nil, 12)
	request[parkedUntilKey] = value(time.Now().Add(30 * time.Millisecond).UnixMilli())
	d.route(agent, request)
	d.mu.Unlock()
	time.Sleep(100 * time.Millisecond)
	response := serviceNextMessage(t, agent).object("response")
	if response.boolean("ok") || response.object("error").text("code") != "EXTENSION_DISCONNECTED" {
		t.Fatalf("unexpected expiry response: %v", response)
	}
}

func TestNoWaitWhenNoBrowserIsExpected(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	d.mu.Lock()
	d.route(agent, newRequest("page.get_state", nil, nil, 12))
	parked := len(d.parked)
	d.mu.Unlock()
	if parked != 0 || len(agent.out) != 1 {
		t.Fatal("waited for a browser that was never connected")
	}
}

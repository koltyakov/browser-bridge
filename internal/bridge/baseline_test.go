package bridge

import (
	"strings"
	"testing"
	"time"
)

func TestBaselineRegistryOwnershipBoundsAndExpiry(t *testing.T) {
	b := newBaselineRegistry()
	p, foreign := &peer{id: "extension"}, &peer{id: "other"}
	id := "baseline_" + strings.Repeat("a", 43)
	expires := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	if !b.register(id, p, expires) || b.register(id, foreign, expires) {
		t.Fatal("baseline ownership can be stolen")
	}
	for _, date := range []string{"invalid", time.Now().Add(-time.Second).Format(time.RFC3339Nano), time.Now().Add(time.Hour).Format(time.RFC3339Nano)} {
		if b.register(id, p, date) {
			t.Fatal("invalid expiry accepted")
		}
	}
	if b.register("../baseline", p, expires) {
		t.Fatal("invalid baseline ID accepted")
	}
	for i := 0; i < 140; i++ {
		id := "baseline_" + strings.ReplaceAll(uniqueID(), "-", "")
		if !b.register(id, p, expires) {
			t.Fatal("valid baseline registration failed")
		}
	}
	if len(b.owners) != 128 {
		t.Fatalf("baseline map unbounded: %d", len(b.owners))
	}
	b.owners["expired"] = baselineOwner{target: p, expires: time.Now().Add(-time.Second)}
	b.prune()
	if _, exists := b.owners["expired"]; exists {
		t.Fatal("expired baseline retained")
	}
	for i := 0; i < 140; i++ {
		b.abandon(uniqueID(), &pendingRequest{target: p, method: "dom.baseline.create"})
	}
	if len(b.abandoned) != 128 {
		t.Fatalf("abandoned create map unbounded: %d", len(b.abandoned))
	}
	b.clear(p)
	if len(b.owners) != 0 || len(b.abandoned) != 0 {
		t.Fatal("extension disconnect retained baseline mappings")
	}
}

func TestBaselineDaemonRoutesAcrossAgentConnections(t *testing.T) {
	d := serviceTestDaemon(t)
	creator := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	id := "baseline_" + strings.Repeat("x", 43)
	d.route(creator, newRequest("dom.baseline.create", object{}, object{"target_extension": value(extension.id)}, 0))
	request := serviceNextMessage(t, extension).object("request")
	d.response(extension, success(request.text("id"), object{"baselineId": value(id), "expiresAt": value(time.Now().Add(time.Minute).Format(time.RFC3339Nano))}))
	if !serviceNextMessage(t, creator).object("response").boolean("ok") {
		t.Fatal("baseline create failed")
	}
	d.disconnect(creator)
	_ = serviceNextMessage(t, extension) // owner_disconnected is independent of baseline capability.
	reader := serviceTestPeer(t, d, "agent")
	d.route(reader, newRequest("dom.baseline.describe", object{"baselineId": value(id)}, nil, 0))
	routed := serviceNextMessage(t, extension).object("request")
	if routed.text("method") != "dom.baseline.describe" || len(foreign.out) != 0 {
		t.Fatal("baseline did not route back to its extension")
	}
	d.response(foreign, success(routed.text("id"), object{}))
	if len(reader.out) != 0 {
		t.Fatal("foreign extension answered baseline request")
	}
	d.response(extension, success(routed.text("id"), object{"baselineId": value(id)}))
	if !serviceNextMessage(t, reader).object("response").boolean("ok") {
		t.Fatal("cross-client baseline read failed")
	}
	d.route(reader, newRequest("dom.baseline.compare", object{"baselineId": value(id)}, object{"target_extension": value(foreign.id)}, 0))
	if serviceNextMessage(t, reader).object("response").object("error").text("code") != "DOM_BASELINE_NOT_FOUND" {
		t.Fatal("explicit wrong destination bypassed baseline ownership")
	}
	d.route(reader, newRequest("dom.baseline.release", object{"baselineId": value(id)}, nil, 0))
	release := serviceNextMessage(t, extension).object("request")
	d.response(extension, success(release.text("id"), object{"released": value(true)}))
	_ = serviceNextMessage(t, reader)
	d.route(reader, newRequest("dom.baseline.release", object{"baselineId": value(id)}, nil, 0))
	response := serviceNextMessage(t, reader).object("response")
	if !response.boolean("ok") || response.object("result").boolean("released") || len(extension.out) != 0 {
		t.Fatal("missing release did not resolve locally")
	}
}

func TestBaselineDaemonLateCreateReleasesOnlyOwnedOrphan(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	d.route(agent, newRequest("dom.baseline.create", object{}, object{"target_extension": value(extension.id)}, 0))
	request := serviceNextMessage(t, extension).object("request")
	d.disconnect(agent)
	_ = serviceNextMessage(t, extension)
	result := object{"baselineId": value("baseline_" + strings.Repeat("b", 43)), "expiresAt": value(time.Now().Add(time.Minute).Format(time.RFC3339Nano)), "scope": value(object{"tabId": value(42)})}
	d.response(foreign, success(request.text("id"), result))
	if len(foreign.out) != 0 || len(d.baselines.abandoned) != 1 {
		t.Fatal("foreign response consumed abandoned create")
	}
	d.response(extension, success(request.text("id"), result))
	release := serviceNextMessage(t, extension).object("request")
	if release.text("method") != "dom.baseline.release" || release.number("tab_id") != 42 || release.object("params").text("baselineId") != result.text("baselineId") || len(d.baselines.abandoned) != 0 || len(d.baselines.owners) != 0 {
		t.Fatal("late baseline create was not released")
	}
}

func TestBaselineDaemonRejectsForgedMetadataAndEvictions(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	id := "baseline_" + strings.Repeat("f", 43)
	if !d.baselines.register(id, foreign, time.Now().Add(time.Minute).Format(time.RFC3339Nano)) {
		t.Fatal("register fixture")
	}
	d.route(agent, newRequest("dom.baseline.create", object{}, object{"target_extension": value(extension.id)}, 0))
	r := serviceNextMessage(t, extension).object("request")
	d.response(extension, success(r.text("id"), object{"baselineId": value(id), "expiresAt": value(time.Now().Add(time.Minute).Format(time.RFC3339Nano)), "evicted": value([]object{{"baselineId": value(id)}})}))
	if serviceNextMessage(t, agent).object("response").object("error").text("code") != "DOM_BASELINE_INVALIDATED" {
		t.Fatal("duplicate baseline ID accepted")
	}
	if d.baselines.owners[id].target != foreign {
		t.Fatal("forged eviction removed another extension's baseline")
	}
	if serviceNextMessage(t, extension).object("request").text("method") != "dom.baseline.release" {
		t.Fatal("rejected baseline was not released")
	}
	d.handle(foreign, object{"type": value("extension.access_update"), "accessEnabled": value(false)})
	if len(d.baselines.owners) != 0 {
		t.Fatal("access revocation retained baselines")
	}
}

func TestBaselineDaemonReleasesUndeliveredCreateResponse(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	d.route(agent, newRequest("dom.baseline.create", object{}, nil, 0))
	r := serviceNextMessage(t, extension).object("request")
	id := "baseline_" + strings.Repeat("u", 43)
	d.response(extension, success(r.text("id"), object{"baselineId": value(id), "expiresAt": value(time.Now().Add(time.Minute).Format(time.RFC3339Nano))}))
	queued := <-agent.out
	agent.queuedBytes.Add(-queued.bytes)
	if queued.onWrite == nil {
		t.Fatal("baseline delivery is not tracked")
	}
	queued.onWrite(false)
	if len(d.baselines.owners) != 0 {
		t.Fatal("failed response delivery retained baseline ownership")
	}
	if serviceNextMessage(t, extension).object("request").text("method") != "dom.baseline.release" {
		t.Fatal("failed response delivery did not release baseline")
	}
}

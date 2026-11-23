package bridge

import (
	"testing"
	"time"
)

func extensionUpdateTestPeer(t *testing.T, d *daemon, version, id string, supported bool) *peer {
	t.Helper()
	p := serviceTestPeer(t, d, "extension")
	d.identity(p, object{"extensionVersion": value(version), "browserExtensionId": value(id), "extensionUpdateChecks": value(supported)})
	return p
}

func TestExtensionUpdateChecksOnlyOlderMatchingCapablePeersAndRespectsCooldown(t *testing.T) {
	d := serviceTestDaemon(t)
	older := extensionUpdateTestPeer(t, d, "2.2.1", publishedExtensionID, true)
	newer := extensionUpdateTestPeer(t, d, "2.3.0", publishedExtensionID, true)
	legacy := extensionUpdateTestPeer(t, d, "2.1.0", publishedExtensionID, false)
	other := extensionUpdateTestPeer(t, d, "9.0.0", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)
	now := time.Now()
	d.checkExtensionUpdates(now)
	message := serviceNextMessage(t, older)
	if message.text("type") != "extension.update_check" || message.text("version") != "2.3.0" {
		t.Fatal(message)
	}
	for _, p := range []*peer{newer, legacy, other} {
		if len(p.out) != 0 {
			t.Fatal("checked a legacy, unrelated, or already-current extension")
		}
	}
	d.checkExtensionUpdates(now.Add(time.Hour))
	if len(older.out) != 0 {
		t.Fatal("repeated a check during cooldown")
	}
	delete(d.peers, newer) // A browser closing must not erase observed upgrade evidence.
	d.checkExtensionUpdates(now.Add(25 * time.Hour))
	if serviceNextMessage(t, older).text("type") != "extension.update_check" {
		t.Fatal("did not check again after cooldown")
	}
}

func TestExtensionReloadDrainsExistingCallsAndNeverDispatchesNewWork(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := extensionUpdateTestPeer(t, d, "2.2.1", publishedExtensionID, true)
	agent := serviceTestPeer(t, d, "agent")
	d.route(agent, newRequest("dom.query", object{"selector": value("main")}, object{"target_extension": value(extension.id)}, 0))
	request := serviceNextMessage(t, extension).object("request")
	d.requestExtensionReload(extension, "2.3.0")
	if len(extension.out) != 0 {
		t.Fatal("granted reload before the active call settled")
	}
	d.route(agent, newRequest("dom.query", nil, object{"target_extension": value(extension.id)}, 0))
	rejected := serviceNextMessage(t, agent).object("response")
	if rejected.boolean("ok") || rejected.object("error").object("details").boolean("dispatched") ||
		rejected.object("error").object("details").text("reason") != "extension_updating" {
		t.Fatal("new work reached a draining extension", rejected)
	}
	d.response(extension, success(request.text("id"), object{"nodes": value([]object{})}))
	if !serviceNextMessage(t, agent).object("response").boolean("ok") {
		t.Fatal("interrupted the original call")
	}
	apply := serviceNextMessage(t, extension)
	if apply.text("type") != "extension.update_apply" || apply.text("version") != "2.3.0" {
		t.Fatal(apply)
	}
	d.grantExtensionReload(extension)
	if len(extension.out) != 0 {
		t.Fatal("replayed a reload grant")
	}
	d.checkExtensionUpdates(time.Now().Add(time.Minute))
	if !extension.updateReadyAt.IsZero() {
		t.Fatal("stale drain did not expire")
	}
	d.requestExtensionReload(extension, "2.3.0")
	d.cancelExtensionReload(extension)
	if !extension.updateReadyAt.IsZero() || extension.updateApplySent {
		t.Fatal("failed to cancel the drain")
	}
}

func TestExtensionUpdateNativeControlMessagesRoundTrip(t *testing.T) {
	for _, kind := range []string{"update_check", "update_apply"} {
		if got := daemonToNative(object{"type": value("extension." + kind)}); got.text("type") != "host."+kind {
			t.Fatal(kind, got)
		}
	}
	for _, kind := range []string{"update_ready", "update_cancel"} {
		if got := nativeToDaemon(object{"type": value("host." + kind)}); got.text("type") != "extension."+kind {
			t.Fatal(kind, got)
		}
	}
}

func TestExtensionReloadIsGrantedWhenTheOnlyCallerDisconnects(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := extensionUpdateTestPeer(t, d, "2.2.1", publishedExtensionID, true)
	agent := serviceTestPeer(t, d, "agent")
	d.route(agent, newRequest("dom.query", object{"selector": value("main")}, object{"target_extension": value(extension.id)}, 0))
	_ = serviceNextMessage(t, extension)
	d.requestExtensionReload(extension, "2.3.0")
	if len(extension.out) != 0 {
		t.Fatal("granted reload before the active call settled")
	}
	d.disconnect(agent)
	sawApply := false
	for len(extension.out) > 0 {
		if serviceNextMessage(t, extension).text("type") == "extension.update_apply" {
			sawApply = true
		}
	}
	if !sawApply {
		t.Fatal("reload stayed pending after the caller disconnected")
	}
}

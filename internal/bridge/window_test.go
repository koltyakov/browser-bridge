package bridge

import (
	"strings"
	"testing"
)

func TestWindowActionRoutesOnlyCurrentWindowAndTargetReplies(t *testing.T) {
	d := serviceTestDaemon(t)
	source := serviceTestPeer(t, d, "extension")
	target := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	source.windowControl, target.windowControl = true, true
	target.window = object{"windowId": value(42), "enabledAt": value(100.5), "title": value("Current window")}
	request := object{"type": value("extension.window_action.request"), "requestId": value("ui-request"), "extensionId": value(target.id), "action": value("focus"), "windowId": value(42), "enabledAt": value(100.5)}
	d.handle(source, request)
	command := serviceNextMessage(t, target)
	if command.text("type") != "extension.window_action.command" || command.text("requestId") == "ui-request" || command.text("action") != "focus" {
		t.Fatal("window action was not remapped")
	}
	result := object{"type": value("extension.window_action.result"), "requestId": command["requestId"], "ok": value(true)}
	d.handle(foreign, result)
	if len(source.out) != 0 || len(d.windowActions) != 1 {
		t.Fatal("foreign response completed window action")
	}
	d.handle(target, result)
	response := serviceNextMessage(t, source)
	if !response.boolean("ok") || response.text("requestId") != "ui-request" || len(d.windowActions) != 0 {
		t.Fatal("window result failed")
	}
	request["enabledAt"] = value(99)
	d.handle(source, request)
	if serviceNextMessage(t, source).boolean("ok") || len(target.out) != 0 {
		t.Fatal("stale enabledAt accepted")
	}
	request["enabledAt"] = value(100.5)
	d.handle(source, request)
	_ = serviceNextMessage(t, target)
	d.disconnect(target)
	if response := serviceNextMessage(t, source); response.boolean("ok") || !strings.Contains(response.text("error"), "disconnected") {
		t.Fatal("target disconnect did not finish window action")
	}
}

func TestWindowActionCapabilitiesLimitsAndSanitization(t *testing.T) {
	d := serviceTestDaemon(t)
	source := serviceTestPeer(t, d, "extension")
	target := serviceTestPeer(t, d, "extension")
	target.windowControl = true
	target.window = object{"windowId": value(1), "enabledAt": value(0), "title": value("Window")}
	request := object{"type": value("extension.window_action.request"), "requestId": value("ui"), "extensionId": value(target.id), "action": value("disable"), "windowId": value(1), "enabledAt": value(0)}
	d.handle(source, request)
	if serviceNextMessage(t, source).boolean("ok") || len(target.out) != 0 {
		t.Fatal("unadvertised control capability accepted")
	}
	source.windowControl = true
	for i := 0; i < 16; i++ {
		d.handle(source, request)
		_ = serviceNextMessage(t, target)
	}
	d.handle(source, request)
	if serviceNextMessage(t, source).boolean("ok") || len(d.windowActions) != 16 {
		t.Fatal("per-source pending limit exceeded")
	}
	for id := range d.windowActions {
		d.finishWindowAction(id, "stopped")
		_ = serviceNextMessage(t, source)
	}
	d.handle(source, request)
	command := serviceNextMessage(t, target)
	d.handle(target, object{"type": value("extension.window_action.result"), "requestId": command["requestId"], "ok": value(false), "error": value("Authorization: Bearer private-secret\nhttps://example.com/?token=private-query")})
	response := serviceNextMessage(t, source)
	if strings.Contains(response.text("error"), "private-secret") || strings.Contains(response.text("error"), "private-query") {
		t.Fatal("window error leaked incidental secrets")
	}
	d.identity(source, object{"windowAccessUpdates": value(true), "windowActions": value(true)})
	d.handle(target, object{"type": value("extension.access_update"), "accessEnabled": value(true), "enabledWindow": value(object{"windowId": value(1), "enabledAt": value(1), "title": value("https://example.com/?token=hidden"), "url": value("https://private.example/")})})
	message := serviceNextMessage(t, source)
	if message.text("type") != "extension.window_access" || strings.Contains(string(value(message)), "hidden") || strings.Contains(string(value(message)), "private.example") || !strings.Contains(string(value(message)), "canControl") {
		t.Fatal("window metadata was not normalized")
	}
}

package bridge

import (
	"strings"
	"testing"
)

func accessSettingsFixture(revision string, create bool) object {
	return object{"settingsRevision": value(revision), "settings": value(object{
		"allowCreatingTabs": value(create), "allowClosingUserTabs": value(false),
		"closeAiTabsWhenDone": value(true), "allowOffDomainNavigation": value(false),
	})}
}

func TestAccessSettingsAreLiveInDaemonHealthAndAgentOutput(t *testing.T) {
	d := serviceTestDaemon(t)
	extension := serviceTestPeer(t, d, "extension")
	revision := "00000000-0000-4000-8000-000000000001"
	policy := accessSettingsFixture(revision, false)
	policy["private"] = value("never-forward")
	d.handle(extension, object{"type": value("extension.access_update"), "accessEnabled": value(true), "enabledWindow": value(object{"windowId": value(7), "enabledAt": value(100)}), "accessSettings": value(policy)})
	if snapshot := d.snapshot()[0].object("accessSettings"); snapshot.text("settingsRevision") != revision || snapshot.object("settings").boolean("allowCreatingTabs") || snapshot["private"] != nil {
		t.Fatalf("invalid normalized policy: %s", value(snapshot))
	}
	health := d.health(object{"extension": value("ok"), "accessSettings": value(policy)}, false)
	if health.object("accessSettings").text("settingsRevision") != revision {
		t.Fatal("compact health lost current settings")
	}
	response := success("read", object{"tabs": value([]object{})})
	response["meta"] = value(object{"access_settings": value(policy)})
	if cliSummaryNow(response, "tabs.list").object("accessSettings").text("settingsRevision") != revision {
		t.Fatal("agent summary lost updated settings")
	}
	if mcpResponse(response, "tabs.list", nil).object("structuredContent").object("accessSettings").text("settingsRevision") != revision {
		t.Fatal("MCP output lost updated settings")
	}
	policy = accessSettingsFixture("00000000-0000-4000-8000-000000000002", true)
	d.handle(extension, object{"type": value("extension.access_update"), "accessEnabled": value(true), "enabledWindow": value(object{"windowId": value(7), "enabledAt": value(100)}), "accessSettings": value(policy)})
	if !d.snapshot()[0].object("accessSettings").object("settings").boolean("allowCreatingTabs") || !extension.access {
		t.Fatal("setting change required a reconnect or revoked existing access")
	}
	policy["reason"], policy["setting"] = value("policy_setting_disabled"), value("allowCreatingTabs")
	if text := mcpErrorDetailsText(value(policy)); !strings.Contains(text, policy.text("settingsRevision")) || !strings.Contains(text, "access.wait_for_change") {
		t.Fatal("text-only MCP client cannot discover the wait revision")
	}
}

func TestAccessSettingsNormalizationRejectsPartialOrUnboundedState(t *testing.T) {
	for _, policy := range []object{nil, accessSettingsFixture("invalid", true), accessSettingsFixture(strings.Repeat("x", 129), true), {"settingsRevision": value("00000000-0000-4000-8000-000000000001"), "settings": value(object{"allowCreatingTabs": value("true")})}} {
		if normalizeAccessSettingsSnapshot(policy) != nil {
			t.Fatal("invalid access settings accepted")
		}
	}
}

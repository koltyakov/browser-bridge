package bridge

import "testing"

func TestBrowserTargetKeepsChromeAndBraveSeparate(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	chrome := serviceTestPeer(t, d, "extension")
	brave := serviceTestPeer(t, d, "extension")
	d.identity(chrome, object{"browserName": value("chrome")})
	d.identity(brave, object{"browserName": value("brave")})
	for _, selected := range []string{"brave", "chrome"} {
		target, other := brave, chrome
		if selected == "chrome" {
			target, other = chrome, brave
		}
		request := newRequest("page.get_state", nil, object{"target_browser": value(selected)}, 12)
		d.route(agent, request)
		forwarded := serviceNextMessage(t, target).object("request")
		if forwarded.text("method") != "page.get_state" || len(other.out) != 0 {
			t.Fatal("browser-targeted request reached the wrong extension")
		}
		d.response(target, success(forwarded.text("id"), object{"browser": value(selected)}))
		response := serviceNextMessage(t, agent).object("response")
		if !response.boolean("ok") || response.object("result").text("browser") != selected {
			t.Fatal("browser response routing changed", response)
		}
	}
	delete(d.peers, brave)
	d.route(agent, newRequest("page.get_state", nil, object{"target_browser": value("brave")}, 12))
	if response := serviceNextMessage(t, agent).object("response"); response.boolean("ok") || len(chrome.out) != 0 {
		t.Fatal("missing Brave target fell back to Chrome", response)
	}
}

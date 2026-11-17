package bridge

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"testing"
)

func mcpTestConversationCall(id int, name string, args object, modern bool, session json.RawMessage) object {
	message := mcpTestCall(id, name, args, modern)
	params := message.object("params")
	envelope := params.object("_meta")
	if envelope == nil {
		envelope = object{}
	}
	if session != nil {
		envelope[openCodeSessionKey] = session
	}
	params["_meta"] = value(envelope)
	message["params"] = value(params)
	return message
}

func TestMCPConversationContext(t *testing.T) {
	t.Setenv("BBX_SESSION", "explicit-session")
	s := &mcpSession{}
	base := context.Background()
	absent, err := s.conversationContext(base, object{"unrelated/key": value(17)})
	if err != nil || absent != base {
		t.Fatalf("unrecognized metadata changed the context: %v", err)
	}
	envelope := object{openCodeSessionKey: value("ses_private-conversation")}
	ctx, err := s.conversationContext(base, envelope)
	if err != nil {
		t.Fatal(err)
	}
	identity := ctx.Value(mcpConversationContextKey{}).(string)
	if !regexp.MustCompile(`^mcp_[a-f0-9]{64}$`).MatchString(identity) || strings.Contains(identity, "private") {
		t.Fatalf("identity is unsafe or leaks host metadata: %q", identity)
	}
	again, err := s.conversationContext(base, envelope)
	if err != nil || again.Value(mcpConversationContextKey{}) != identity {
		t.Fatalf("conversation identity changed: %v", err)
	}
	if s.agentSession != "explicit-session" {
		t.Fatal("host metadata replaced the fallback session")
	}
	for _, other := range []*mcpSession{
		{agentSession: s.agentSession},
		{agentSession: "another-namespace", conversationNamespace: s.conversationNamespace},
	} {
		ctx, err := other.conversationContext(base, envelope)
		if err != nil || ctx.Value(mcpConversationContextKey{}) == identity {
			t.Fatalf("unrelated server/session namespaces collided: %v", err)
		}
	}
	different, err := s.conversationContext(base, object{openCodeSessionKey: value("ses_another-conversation")})
	if err != nil || different.Value(mcpConversationContextKey{}) == identity {
		t.Fatalf("host conversations collided: %v", err)
	}
	// Opaque IDs are not trimmed or normalized into the same identity.
	spaced, err := s.conversationContext(base, object{openCodeSessionKey: value(" ses_private-conversation ")})
	if err != nil || spaced.Value(mcpConversationContextKey{}) == identity {
		t.Fatalf("opaque host ID was normalized: %v", err)
	}
}

func TestMCPConversationMetadataValidation(t *testing.T) {
	for _, raw := range []json.RawMessage{
		value(""), value(" \t "), value("line\nbreak"), value("control\u0085"),
		value(strings.Repeat("x", maxHostSessionBytes+1)), value(17), value(false),
		value[*string](nil), value([]string{"session"}), value(object{"id": value("session")}),
		json.RawMessage(`"\ud800"`), json.RawMessage(`"\ud801"`), json.RawMessage(`"\udfff"`),
		json.RawMessage{'"', 0xff, '"'},
	} {
		s := &mcpSession{}
		if _, err := s.conversationContext(context.Background(), object{openCodeSessionKey: raw}); err == nil {
			t.Fatalf("invalid metadata accepted: %s", raw)
		}
		if s.agentSession != "" || s.conversationNamespace != "" {
			t.Fatal("invalid metadata initialized an identity")
		}
	}
	for _, session := range []string{strings.Repeat("x", maxHostSessionBytes), "会話:opaque/id", "\ufffd", "🚀"} {
		s := &mcpSession{}
		if _, err := s.conversationContext(context.Background(), object{openCodeSessionKey: value(session)}); err != nil {
			t.Fatalf("valid opaque ID rejected: %v", err)
		}
	}
	s := &mcpSession{}
	escaped, err := s.conversationContext(context.Background(), object{openCodeSessionKey: json.RawMessage(`"\ud83d\ude80"`)})
	if err != nil {
		t.Fatal("valid surrogate pair rejected:", err)
	}
	literal, err := s.conversationContext(context.Background(), object{openCodeSessionKey: value("🚀")})
	if err != nil || escaped.Value(mcpConversationContextKey{}) != literal.Value(mcpConversationContextKey{}) {
		t.Fatal("equivalent Unicode encodings changed the identity")
	}
}

func TestMCPConversationIdentityIsRequestLocal(t *testing.T) {
	t.Setenv("BBX_SESSION", "explicit-session")
	for _, modern := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "modern"}[modern], func(t *testing.T) {
			c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
			peer := mcpTestStart(t, c)
			if !modern {
				peer.send(t, mcpTestRequest(0, "initialize", nil, false))
				peer.read(t)
			}
			identities := map[string]string{}
			for i, host := range []string{"", "ses_a", "ses_b", "ses_a", "", "ses_b"} {
				var session json.RawMessage
				if host != "" {
					session = value(host)
				}
				peer.send(t, mcpTestConversationCall(i+1, "browser_health", object{}, modern, session))
				if peer.read(t).object("result").boolean("isError") {
					t.Fatal("health call failed")
				}
				request := <-requests
				identity := request.object("meta").text("agent_session")
				if strings.Contains(string(value(request)), "ses_a") || strings.Contains(string(value(request)), "ses_b") {
					t.Fatal("raw host session ID leaked downstream")
				}
				if previous := identities[host]; previous != "" && previous != identity {
					t.Fatalf("identity for %q changed", host)
				}
				identities[host] = identity
			}
			if identities[""] != "explicit-session" || identities["ses_a"] == identities["ses_b"] || identities["ses_a"] == identities[""] || identities["ses_b"] == identities[""] {
				t.Fatalf("conversation or fallback identities merged: %v", identities)
			}
		})
	}
}

func TestMCPConversationContextPropagatesThroughFanout(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "health.ping" {
			return success(request.text("id"), object{"connectedExtensions": value([]object{{"extensionId": value("profile-a"), "accessEnabled": value(true)}, {"extensionId": value("profile-b"), "accessEnabled": value(true)}})})
		}
		return success(request.text("id"), object{"tabs": value([]object{})})
	})
	peer := mcpTestStart(t, c)
	identity := ""
	for i, args := range []object{
		{"method": value("page.get_state"), "tabId": value(11)},
		{"calls": value([]object{{"method": value("page.get_state"), "tabId": value(11)}, {"method": value("dom.query"), "tabId": value(11)}})},
		{"method": value("input.perform"), "tabId": value(11), "params": value(object{"steps": value([]object{{"method": value("input.click"), "params": value(object{"target": value(object{"selector": value("button")})})}})})},
		{"method": value("tabs.list")},
	} {
		name, count := "browser_call", 1
		switch i {
		case 1:
			name, count = "browser_batch", 2
		case 3:
			count = 3 // Discovery plus one read for each enabled profile.
		}
		peer.send(t, mcpTestConversationCall(i+1, name, args, true, value("ses_origin")))
		if peer.read(t).object("result").boolean("isError") {
			t.Fatal("nested operation failed")
		}
		for range count {
			request := <-requests
			got := request.object("meta").text("agent_session")
			if identity == "" {
				identity = got
			}
			if got != identity {
				t.Fatalf("nested request lost its conversation: %s", value(request))
			}
		}
	}
}

func TestMCPConversationCallsDoNotShareMutableIdentity(t *testing.T) {
	s := &mcpSession{agentSession: "fallback"}
	const count = 32
	identities := make([]string, count)
	var workers sync.WaitGroup
	for i := range count {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			ctx, err := s.conversationContext(context.Background(), object{openCodeSessionKey: value([]string{"ses_a", "ses_b"}[i%2])})
			if err != nil {
				t.Error(err)
				return
			}
			identities[i] = ctx.Value(mcpConversationContextKey{}).(string)
		}(i)
	}
	workers.Wait()
	for i, identity := range identities {
		if identity == "" || identity != identities[i%2] {
			t.Fatal("concurrent requests changed each other's identity")
		}
	}
	if identities[0] == identities[1] || s.agentSession != "fallback" {
		t.Fatal("concurrent conversations share an identity or changed the fallback")
	}
}

func TestMCPMalformedConversationMetadataNeverDispatches(t *testing.T) {
	for _, modern := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "modern"}[modern], func(t *testing.T) {
			c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
			peer := mcpTestStart(t, c)
			if !modern {
				peer.send(t, mcpTestRequest(0, "initialize", nil, false))
				peer.read(t)
			}
			for i, raw := range []json.RawMessage{value(""), value(42), value[*string](nil), value("bad\nid")} {
				peer.send(t, mcpTestConversationCall(i+1, "browser_health", object{}, modern, raw))
				if response := peer.read(t); response.object("error").number("code") != -32602 {
					t.Fatalf("invalid identity did not fail as invalid params: %s", value(response))
				}
			}
			select {
			case request := <-requests:
				t.Fatalf("invalid identity reached the daemon: %s", value(request))
			default:
			}
			peer.send(t, mcpTestConversationCall(10, "browser_health", object{}, modern, value("ses_valid")))
			if peer.read(t).object("result").boolean("isError") {
				t.Fatal("invalid metadata poisoned subsequent requests")
			}
		})
	}
}

func TestMCPLegacyRejectsMalformedMetadataEnvelope(t *testing.T) {
	peer := mcpTestStart(t, config{home: t.TempDir()})
	peer.send(t, mcpTestRequest(0, "initialize", nil, false))
	peer.read(t)
	for i, raw := range []json.RawMessage{value[*string](nil), value("invalid"), value([]object{})} {
		message := mcpTestCall(i+1, "browser_health", object{}, false)
		params := message.object("params")
		params["_meta"] = raw
		message["params"] = value(params)
		peer.send(t, message)
		if peer.read(t).object("error").number("code") != -32602 {
			t.Fatal("malformed metadata envelope was accepted")
		}
	}
}

package bridge

import (
	"context"
	"strings"
	"testing"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

func clearCallerEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{"BBX_AGENT", "OPENCODE", "CLAUDECODE", "CODEX_THREAD_ID", "CODEX_CI", "CURSOR_AGENT", "GEMINI_CLI"} {
		t.Setenv(key, "")
	}
}

func TestEnvironmentCaller(t *testing.T) {
	for _, tt := range []struct {
		name   string
		env    map[string]string
		want   string
		source string
		signal string
	}{
		{"unknown", nil, "", "", ""},
		{"opencode", map[string]string{"OPENCODE": "true"}, "OpenCode", "environment", "OPENCODE"},
		{"claude", map[string]string{"CLAUDECODE": "1"}, "Claude Code", "environment", "CLAUDECODE"},
		{"codex", map[string]string{"CODEX_THREAD_ID": "private-thread", "CODEX_CI": "1"}, "Codex (OpenAI)", "environment", "CODEX_THREAD_ID"},
		{"cursor", map[string]string{"CURSOR_AGENT": "true"}, "Cursor", "environment", "CURSOR_AGENT"},
		{"gemini", map[string]string{"GEMINI_CLI": "1"}, "Gemini CLI", "environment", "GEMINI_CLI"},
		{"disabled", map[string]string{"OPENCODE": "false", "CLAUDECODE": "0"}, "", "", ""},
		{"config is not caller", map[string]string{"OPENCODE_CONFIG": "config.json", "CODEX_HOME": "private-path"}, "", "", ""},
		{"ambiguous", map[string]string{"OPENCODE": "1", "CLAUDECODE": "1"}, "", "", ""},
		{"override", map[string]string{"BBX_AGENT": " claude-code ", "OPENCODE": "1"}, "Claude Code", "explicit", ""},
		{"custom", map[string]string{"BBX_AGENT": "My Agent"}, "My Agent", "explicit", ""},
		{"invalid override", map[string]string{"BBX_AGENT": "https://user:secret@example.com", "OPENCODE": "1"}, "", "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			caller := environmentCaller(func(key string) string { return tt.env[key] })
			if tt.want == "" {
				if caller != nil {
					t.Fatalf("unexpected attribution: %s", value(caller))
				}
				return
			}
			if caller == nil || caller.Name != tt.want || string(caller.Source) != tt.source || caller.Signal.Value != tt.signal {
				t.Fatalf("wrong caller: %s", value(caller))
			}
			if strings.Contains(string(value(caller)), "private-") {
				t.Fatal("environment value leaked into attribution")
			}
		})
	}
}

func TestCallerMetadataNormalization(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `"opencode"`, `{}`, `{"name":"bad\nname","source":"mcp"}`, `{"name":"OpenCode","source":"verified"}`, `{"name":"/private/path","source":"mcp"}`} {
		if caller := normalizeCaller([]byte(raw)); caller != nil {
			t.Fatalf("invalid caller accepted: %s", value(caller))
		}
	}
	meta := object{"source": value("cli"), "caller": value(object{"name": value(" OpenCode "), "version": value(" 2.0.0-beta.1 "), "source": value("environment"), "signal": value("OPENCODE"), "token": value("private-secret")})}
	normalizeDaemonRequestMeta(meta)
	if !jsonEqual(meta["caller"], value(object{"name": value("OpenCode"), "version": value("2.0.0-beta.1"), "source": value("environment"), "signal": value("OPENCODE")})) {
		t.Fatalf("caller not normalized: %s", value(meta))
	}
	caller := normalizeCaller(value(object{"name": value("Agent"), "version": value("bad version"), "source": value("mcp"), "signal": value("SECRET")}))
	if caller == nil || caller.Version.Set || caller.Signal.Set {
		t.Fatalf("incidental fields retained: %s", value(caller))
	}
	meta["source"] = value("foreign")
	normalizeDaemonRequestMeta(meta)
	if meta["caller"] != nil {
		t.Fatal("attribution retained for an unknown transport source")
	}
}

func TestCLIRequestsIncludeCaller(t *testing.T) {
	clearCallerEnvironment(t)
	t.Setenv("OPENCODE", "true")
	request, err := parseCLI([]string{"health.ping"})
	if err != nil {
		t.Fatal(err)
	}
	caller := request.object("meta").object("caller")
	if caller.text("name") != "OpenCode" || caller.text("signal") != "OPENCODE" {
		t.Fatalf("CLI attribution missing: %s", value(request))
	}
	if newRequest("health.ping", nil, nil, 0).object("meta")["caller"] != nil {
		t.Fatal("internal request inherited CLI attribution")
	}
}

func TestMCPLegacyCallerAttribution(t *testing.T) {
	clearCallerEnvironment(t)
	t.Setenv("OPENCODE", "true")
	c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
	peer := mcpTestStart(t, c)
	peer.send(t, mcpTestRequest(1, "initialize", object{"clientInfo": value(object{"name": value("claude-code"), "version": value("2.1.0"), "secret": value("not-retained")})}, false))
	peer.read(t)
	peer.send(t, mcpTestCall(2, "browser_health", object{}, false))
	peer.read(t)
	caller := (<-requests).object("meta").object("caller")
	if caller.text("name") != "Claude Code" || caller.text("version") != "2.1.0" || caller.text("source") != "mcp" || len(caller) != 3 {
		t.Fatalf("MCP caller not captured: %s", value(caller))
	}
}

func TestMCPModernCallerIsRequestScoped(t *testing.T) {
	clearCallerEnvironment(t)
	c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
	peer := mcpTestStart(t, c)
	for i, name := range []string{"opencode", "codex-mcp-client", ""} {
		message := mcpTestCall(i+1, "browser_health", object{}, true)
		params := message.object("params")
		envelope := params.object("_meta")
		if name != "" {
			envelope["io.modelcontextprotocol/clientInfo"] = value(object{"name": value(name), "version": value("1.0.0")})
		}
		params["_meta"] = value(envelope)
		message["params"] = value(params)
		peer.send(t, message)
		peer.read(t)
		caller := (<-requests).object("meta").object("caller")
		if name == "" {
			if caller != nil {
				t.Fatal("modern request inherited a previous caller")
			}
		} else if caller.text("name") != callerDisplayName(name) || caller.text("source") != "mcp" {
			t.Fatalf("wrong modern caller: %s", value(caller))
		}
	}
}

func TestMCPCallerFallbackAndOverride(t *testing.T) {
	clearCallerEnvironment(t)
	s := &mcpSession{caller: reportedCaller(object{"name": value("claude-code")})}
	t.Setenv("OPENCODE", "true")
	caller := s.callerContext(context.Background(), "modern", nil).Value(mcpCallerContextKey{}).(*protocol.BridgeCaller)
	if caller.Name != "OpenCode" || caller.Source != "environment" {
		t.Fatalf("environment fallback missing: %s", value(caller))
	}
	t.Setenv("BBX_AGENT", "codex")
	caller = s.callerContext(context.Background(), "legacy", nil).Value(mcpCallerContextKey{}).(*protocol.BridgeCaller)
	if caller.Name != "Codex (OpenAI)" || caller.Source != "explicit" {
		t.Fatalf("explicit override ignored: %s", value(caller))
	}
}

func TestDaemonRoutesAndLogsCaller(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	caller := object{"name": value("OpenCode"), "source": value("environment"), "signal": value("OPENCODE"), "secret": value("not-retained")}
	d.route(agent, newRequest("tabs.list", nil, object{"source": value("cli"), "caller": value(caller)}, 0))
	request := serviceNextMessage(t, extension).object("request")
	want := value(object{"name": value("OpenCode"), "source": value("environment"), "signal": value("OPENCODE")})
	if !jsonEqual(request.object("meta")["caller"], want) {
		t.Fatalf("routed caller not normalized: %s", value(request))
	}
	d.response(extension, success(request.text("id"), object{"tabs": value([]object{})}))
	serviceNextMessage(t, agent)
	if len(d.logs) == 0 || !jsonEqual(d.logs[len(d.logs)-1]["caller"], want) {
		t.Fatalf("caller missing from daemon log: %s", value(d.logs))
	}
}

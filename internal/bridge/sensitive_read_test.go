package bridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const sensitiveBodyCanary = "BBX_GO_BODY_CANARY_51d0"

func responseBodyParams() object {
	return object{"source": value("response_body"), "requestId": value("1234.5")}
}

func responseBodyResult(body string) object {
	return object{"source": value("response_body"), "requestId": value("1234.5"), "body": value(body), "encoding": value("text"), "mimeType": value("application/json"), "bytes": value(len(body)), "exact": value(true)}
}

// sensitiveTCPPair returns both ends of a real loopback TCP connection, the
// transport a proxy agent uses.
func sensitiveTCPPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.Accept()
		accepted <- conn
	}()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server := <-accepted
	if server == nil {
		t.Fatal("no accepted connection")
	}
	return server, client
}

// sensitiveWirePeer registers a peer over the given connection pair and
// serves it with the real daemon loop.
func sensitiveWirePeer(t *testing.T, d *daemon, role string, server, connection net.Conn) (*wireWriter, *bufio.Reader) {
	t.Helper()
	p := &peer{conn: server, out: make(chan queuedMessage, 32), done: make(chan struct{}), identity: object{}, owner: uniqueID(), dataTargets: make(map[*peer]bool)}
	d.mu.Lock()
	d.peers[p] = true
	d.mu.Unlock()
	finished := make(chan struct{})
	go func() { defer close(finished); d.serve(p) }()
	t.Cleanup(func() { _ = connection.Close(); _ = server.Close(); <-finished })
	if err := connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	w := &wireWriter{out: connection}
	token := d.agentToken
	if role == "extension" {
		token = d.extensionToken
	}
	if err := w.send(object{"type": value("register"), "role": value(role), "clientId": value(uniqueID()), "authToken": value(token)}); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(connection)
	if ack, err := readLine(r); err != nil || ack.text("type") != "registered" {
		t.Fatalf("registration: %s %v", value(ack), err)
	}
	return w, r
}

func sensitiveTestDaemon(t *testing.T) *daemon {
	t.Helper()
	d := serviceTestDaemon(t)
	d.agentToken, d.extensionToken = strings.Repeat("a", 43), strings.Repeat("e", 43)
	return d
}

// sendSensitiveRequest sends one request and reads the side expected to react:
// the extension when the daemon should forward it, otherwise the agent.
func sendSensitiveRequest(t *testing.T, agent *wireWriter, agentReader, extensionReader *bufio.Reader, params object, expectForward bool) object {
	t.Helper()
	request := newRequest("sensitive.read", params, nil, 0)
	if err := agent.send(object{"type": value("agent.request"), "request": value(request)}); err != nil {
		t.Fatal(err)
	}
	reader := agentReader
	if expectForward {
		reader = extensionReader
	}
	message, err := readLine(reader)
	if err != nil {
		t.Fatalf("expected forward=%v: %v", expectForward, err)
	}
	if expectForward {
		return message.object("request")
	}
	return message.object("response")
}

func TestSensitiveReadRefusesGatedSourcesOverRemoteTransport(t *testing.T) {
	cases := []struct {
		name              string
		proxy, allow, tcp bool
		bind              string
		params            object
		wantForward       bool
	}{
		{name: "proxy tcp body refused", proxy: true, tcp: true, bind: "127.0.0.1:9223", params: responseBodyParams()},
		{name: "proxy tcp body opted in", proxy: true, allow: true, tcp: true, bind: "127.0.0.1:9223", params: responseBodyParams(), wantForward: true},
		{name: "proxy tcp storage unchanged", proxy: true, tcp: true, bind: "127.0.0.1:9223", params: object{"source": value("local_storage"), "key": value("k")}, wantForward: true},
		{name: "lan bind without proxy refused", tcp: true, bind: "0.0.0.0:9223", params: responseBodyParams()},
		{name: "loopback tcp without proxy is local", tcp: true, bind: "127.0.0.1:9223", params: responseBodyParams(), wantForward: true},
		{name: "local socket under proxy is local", proxy: true, bind: "127.0.0.1:9223", params: responseBodyParams(), wantForward: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := sensitiveTestDaemon(t)
			d.config.network, d.config.bind = "tcp", tc.bind
			d.config.proxyTransport, d.config.remoteSensitiveReads = tc.proxy, tc.allow
			_, extensionReader := serviceWirePeer(t, d, "extension")
			var server, client net.Conn
			if tc.tcp {
				server, client = sensitiveTCPPair(t)
			} else {
				server, client = net.Pipe()
			}
			agent, agentReader := sensitiveWirePeer(t, d, "agent", server, client)
			message := sendSensitiveRequest(t, agent, agentReader, extensionReader, tc.params, tc.wantForward)
			if tc.wantForward {
				if message.text("method") != "sensitive.read" {
					t.Fatalf("not forwarded: %s", value(message))
				}
				return
			}
			response := message
			if response.text("id") == "" || response.boolean("ok") {
				t.Fatalf("refused read was not answered by the daemon: %s", value(response))
			}
			e := response.object("error")
			details := e.object("details")
			if e.text("code") != "ACCESS_DENIED" || details.text("reason") != "remote_sensitive_reads_disabled" || details.text("source") != "response_body" || string(details["dispatched"]) != "false" || !strings.Contains(e.text("message"), "--remote-sensitive-reads allow") {
				t.Fatalf("remote refusal: %s", value(response))
			}
			if e.object("recovery").boolean("retry") {
				t.Fatal("remote refusal is retryable")
			}
		})
	}
}

func TestSensitiveReadUnknownSourceListsSupportedSources(t *testing.T) {
	d := sensitiveTestDaemon(t)
	_, extensionReader := serviceWirePeer(t, d, "extension")
	agent, agentReader := serviceWirePeer(t, d, "agent")
	for _, source := range []string{"cache", "Cookie", ""} {
		response := sendSensitiveRequest(t, agent, agentReader, extensionReader, object{"source": value(source), "name": value("sid")}, false)
		e := response.object("error")
		var supported []string
		_ = json.Unmarshal(e.object("details")["supportedSources"], &supported)
		if e.text("code") != "INVALID_REQUEST" || e.object("details").text("reason") != "unsupported_source" || strings.Join(supported, ",") != "local_storage,session_storage,response_body,indexeddb" || !strings.Contains(e.text("message"), "local_storage, session_storage, response_body, indexeddb") {
			t.Fatalf("unknown source %q: %s", source, value(response))
		}
	}
	if !gatedSensitiveSource("cookie") || !gatedSensitiveSource("indexeddb") || !gatedSensitiveSource("cache") || !gatedSensitiveSource("") || gatedSensitiveSource("local_storage") || gatedSensitiveSource("session_storage") || !gatedSensitiveSource("response_body") {
		t.Fatal("gated source classification does not fail closed")
	}
}

func TestSensitiveResponseBodyIsNeverBatchedRetriedOrSummarized(t *testing.T) {
	batch, _ := json.Marshal([]object{{"method": value("sensitive.read"), "params": value(responseBodyParams())}})
	_, invalid, err := prepareCLIBatch(batch, "")
	if err != nil || len(invalid) != 1 || invalid[0] == nil || !strings.Contains(value(invalid[0]).String(), "never allowed in batch") {
		t.Fatalf("CLI batch accepted a body read: %v %s", err, value(invalid))
	}
	if batchSafe("sensitive.read", responseBodyParams()) || mcpRetrySafe("sensitive.read", responseBodyParams()) {
		t.Fatal("body reads are batch or retry safe")
	}
	if !batchSafe("page.get_network", object{"source": value("cdp")}) || batchSafe("page.get_network", object{"source": value("cdp"), "capture": value("start"), "bodies": value(object{})}) || mcpRetrySafe("page.get_network", object{"source": value("cdp"), "capture": value("start"), "bodies": value(object{})}) {
		t.Fatal("capture start with bodies is batch or retry safe")
	}

	c, requests := mcpTestDaemon(t, func(request object) object {
		response := failure(request.text("id"), "TIMEOUT", "Retryable failure.")
		e := response.object("error")
		e["recovery"] = value(object{"retry": value(true), "retryAfterMs": value(0)})
		response["error"] = value(e)
		return response
	})
	s := &mcpSession{config: c, agentSession: "sensitive-body"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	if _, err := s.handleTool(context.Background(), "browser_sensitive_read", object{"source": value("response_body"), "requestId": value("1234.5"), "encoding": value("base64"), "tabId": value(3)}, "modern"); err != nil {
		t.Fatal(err)
	}
	request := <-requests
	if request.object("params").text("requestId") != "1234.5" || request.object("params").text("encoding") != "base64" || request.object("meta")["token_budget"] != nil && string(request.object("meta")["token_budget"]) != "null" {
		t.Fatalf("MCP did not forward the exact locator: %s", value(request))
	}
	select {
	case retried := <-requests:
		t.Fatalf("body read was retried: %s", value(retried))
	case <-time.After(300 * time.Millisecond):
	}
	result, err := s.batch(context.Background(), object{"calls": value([]object{{"method": value("sensitive.read"), "params": value(responseBodyParams())}})}, "modern")
	if err != nil || !result.boolean("isError") {
		t.Fatal("MCP batch accepted a body read")
	}

	body := "\u001b[31m" + strings.Repeat(sensitiveBodyCanary, 3000)
	response := success("x", responseBodyResult(body))
	response["meta"] = value(object{"method": value("sensitive.read")})
	mcp := mcpResponse(response, "sensitive.read", responseBodyParams()).object("structuredContent")
	if mcp.text("body") != body || mcp.text("mimeType") != "application/json" || mcp["deliveredBytes"] != nil || mcp["evidence"] != nil {
		t.Fatalf("MCP summarized or truncated the body: %.200s", value(mcp))
	}
	var out, stderr bytes.Buffer
	if err := writeCLIResponse(response, true, "sensitive.read", 0, &out, &stderr, false, false); err != nil {
		t.Fatal(err)
	}
	var printed object
	if err := json.Unmarshal(out.Bytes(), &printed); err != nil || printed.text("body") != body {
		t.Fatalf("CLI did not print the exact body: %v", err)
	}
	for _, broken := range []object{
		{"source": value("response_body"), "body": value("x"), "exact": value(true)},
		{"source": value("response_body"), "requestId": value("r"), "body": json.RawMessage("null"), "encoding": value("text"), "mimeType": value(""), "bytes": value(1), "exact": value(true)},
		{"source": value("response_body"), "requestId": value("r"), "body": value("x"), "encoding": value("utf16"), "mimeType": value(""), "bytes": value(1), "exact": value(true)},
		{"source": value("response_body"), "requestId": value("r"), "body": value("x"), "encoding": value("text"), "mimeType": value(""), "bytes": value(262145), "exact": value(true)},
		{"source": value("cookie"), "value": value("x"), "exact": value(true)},
	} {
		if !mcpResponse(success("x", broken), "sensitive.read", object{}).boolean("isError") {
			t.Fatalf("invalid sensitive result accepted: %s", value(broken))
		}
	}
}

func TestSensitiveResponseBodyCanaryStaysOutOfDaemonSinks(t *testing.T) {
	d := sensitiveTestDaemon(t)
	extension, extensionReader := serviceWirePeer(t, d, "extension")
	agent, agentReader := serviceWirePeer(t, d, "agent")
	forward := func() object {
		t.Helper()
		if err := agent.send(object{"type": value("agent.request"), "request": value(newRequest("sensitive.read", responseBodyParams(), nil, 0))}); err != nil {
			t.Fatal(err)
		}
		message, err := readLine(extensionReader)
		if err != nil || message.object("request").text("method") != "sensitive.read" {
			t.Fatalf("local body read was not forwarded: %s %v", value(message), err)
		}
		return message.object("request")
	}
	forwarded := forward()
	body := `{"user":"` + sensitiveBodyCanary + `"}`
	if err := extension.send(object{"type": value("extension.response"), "response": value(success(forwarded.text("id"), responseBodyResult(body)))}); err != nil {
		t.Fatal(err)
	}
	reply, err := readLine(agentReader)
	if err != nil {
		t.Fatal(err)
	}
	response := reply.object("response")
	if response.object("result").text("body") != body {
		t.Fatalf("agent did not receive the exact body: %s", value(reply))
	}
	if timing := response.object("meta")["transport_bytes"]; timing != nil {
		t.Fatal("daemon added size telemetry to a sensitive reply")
	}
	// A failed read must not leak a body through error details either.
	forwarded = forward()
	failed := failure(forwarded.text("id"), "RESULT_TOO_LARGE", "Too large.")
	if err := extension.send(object{"type": value("extension.response"), "response": value(failed)}); err != nil {
		t.Fatal(err)
	}
	if reply, err = readLine(agentReader); err != nil || reply.object("response").object("error").object("recovery").boolean("retry") {
		t.Fatalf("failed body read is retryable: %s %v", value(reply), err)
	}

	sinks := map[string]string{}
	for _, method := range []string{"log.tail", "daemon.metrics"} {
		if err := agent.send(object{"type": value("agent.request"), "request": value(newRequest(method, object{"limit": value(100)}, nil, 0))}); err != nil {
			t.Fatal(err)
		}
		local, err := readLine(agentReader)
		if err != nil || !local.object("response").boolean("ok") {
			t.Fatalf("%s: %s %v", method, value(local), err)
		}
		sinks[method] = value(local).String()
	}
	if !strings.Contains(sinks["log.tail"], `"sensitive.read"`) {
		t.Fatal("log.tail did not record the sensitive read at all")
	}
	d.mu.Lock()
	sinks["daemon logs"] = value(d.logs).String()
	sinks["health diagnostics"] = value(d.health(nil, true)).String()
	sinks["recovery telemetry"] = value(d.telemetry.snapshot("daemon")).String()
	d.mu.Unlock()
	// Artifacts, journals and every other file under the bridge home.
	_ = filepath.WalkDir(d.config.home, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if data, readErr := os.ReadFile(path); readErr == nil {
				sinks["file "+path] = string(data)
			}
		}
		return nil
	})
	for name, sink := range sinks {
		if strings.Contains(sink, sensitiveBodyCanary) || strings.Contains(sink, "1234.5") {
			t.Fatalf("%s retained the body or its requestId", name)
		}
	}
}

func TestProxyRemoteSensitiveReadsIsExplicitAndPersistent(t *testing.T) {
	original := &proxyConfig{Enabled: true, Port: 3333, BindHost: "127.0.0.1", Token: strings.Repeat("a", 32)}
	if p, err := resolveProxySettings(original, nil); err != nil || p.RemoteSensitiveReads {
		t.Fatal("remote sensitive reads default on")
	}
	allowed, err := resolveProxySettings(original, []string{"--remote-sensitive-reads", "allow"})
	if err != nil || !allowed.RemoteSensitiveReads || allowed.Token != original.Token {
		t.Fatalf("allow: %#v %v", allowed, err)
	}
	if again, err := resolveProxySettings(&allowed, nil); err != nil || !again.RemoteSensitiveReads {
		t.Fatal("re-running proxy enable dropped the explicit opt-in")
	}
	if denied, err := resolveProxySettings(&allowed, []string{"--remote-sensitive-reads", "deny"}); err != nil || denied.RemoteSensitiveReads {
		t.Fatal("deny did not revoke the opt-in")
	}
	for _, args := range [][]string{{"--remote-sensitive-reads", "yes"}, {"--remote-sensitive-reads"}} {
		if _, err := resolveProxySettings(original, args); err == nil {
			t.Fatalf("invalid option accepted: %v", args)
		}
	}
	home := t.TempDir()
	for raw, want := range map[string]bool{`true`: true, `"true"`: false, `1`: false, `false`: false} {
		if err := os.WriteFile(filepath.Join(home, "proxy.json"), []byte(`{"enabled":true,"port":9223,"bindHost":"127.0.0.1","remoteSensitiveReads":`+raw+`}`), 0o600); err != nil {
			t.Fatal(err)
		}
		p, err := readProxyConfig(config{home: home})
		if err != nil || p == nil || p.RemoteSensitiveReads != want {
			t.Fatalf("remoteSensitiveReads %s: %#v %v", raw, p, err)
		}
	}
	t.Setenv("BROWSER_BRIDGE_HOME", home)
	t.Setenv("BBX_TCP_PORT", "")
	// Map iteration order is random, so write each case again before loading
	// it into the daemon config.
	for raw, want := range map[string]bool{`true`: true, `"true"`: false} {
		if err := os.WriteFile(filepath.Join(home, "proxy.json"), []byte(`{"enabled":true,"port":9223,"bindHost":"127.0.0.1","remoteSensitiveReads":`+raw+`}`), 0o600); err != nil {
			t.Fatal(err)
		}
		c, err := loadConfig()
		if err != nil || !c.proxyTransport || c.remoteSensitiveReads != want {
			t.Fatalf("proxy config %s not loaded into the daemon config: %#v %v", raw, c, err)
		}
	}
	if label := remoteSensitiveReadsLabel(false); !strings.Contains(label, "--remote-sensitive-reads allow") {
		t.Fatal(label)
	}
}

func TestAccessSettingsSnapshotToleratesOlderExtensionsButNotMalformedGate(t *testing.T) {
	legacy := accessSettingsFixture("00000000-0000-4000-8000-000000000001", true)
	snapshot := normalizeAccessSettingsSnapshot(legacy)
	if snapshot == nil || snapshot.Settings.AllowResponseBodyReads {
		t.Fatal("an older extension's settings were dropped or read as opted in")
	}
	current := accessSettingsFixture("00000000-0000-4000-8000-000000000001", true)
	settings := current.object("settings")
	settings["allowResponseBodyReads"] = value(true)
	current["settings"] = value(settings)
	if snapshot = normalizeAccessSettingsSnapshot(current); snapshot == nil || !snapshot.Settings.AllowResponseBodyReads {
		t.Fatal("current gate state lost")
	}
	settings["allowResponseBodyReads"] = value("true")
	current["settings"] = value(settings)
	if normalizeAccessSettingsSnapshot(current) != nil {
		t.Fatal("non-boolean gate accepted")
	}
}

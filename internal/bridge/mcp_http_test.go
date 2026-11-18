package bridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	mcpHTTPTokenA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	mcpHTTPTokenB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func mcpHTTPTestSettings(t *testing.T) mcpHTTPSettings {
	t.Helper()
	clients := make(map[string]string)
	for name, token := range map[string]string{"first": mcpHTTPTokenA, "second": mcpHTTPTokenB} {
		path := filepath.Join(t.TempDir(), name+".token")
		if err := os.WriteFile(path, []byte(token), 0600); err != nil {
			t.Fatal(err)
		}
		clients[name] = path
	}
	return mcpHTTPSettings{Enabled: true, Listen: "127.0.0.1:0", Clients: clients, IdleTimeoutSeconds: 60, MaxLifetimeSeconds: 3600}
}

func mcpHTTPTestStart(t *testing.T, c config) *mcpHTTPServer {
	t.Helper()
	h, err := startMCPHTTP(context.Background(), c, mcpHTTPTestSettings(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.close)
	return h
}

func mcpHTTPTestRequest(t *testing.T, h *mcpHTTPServer, token, session string, message object) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, "http://"+h.listener.Addr().String()+"/mcp", bytes.NewReader(value(message)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("Content-Type", "application/json")
	if session != "" {
		request.Header.Set("Mcp-Session-Id", session)
		request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	}
	params := message.object("params")
	if revision := params.object("_meta").text(versionKey); revision != "" {
		request.Header.Set("MCP-Protocol-Version", revision)
		request.Header.Set("Mcp-Method", message.text("method"))
		if name := params.text("name"); name != "" {
			request.Header.Set("Mcp-Name", name)
		}
	}
	return request
}

func mcpHTTPTestDo(t *testing.T, request *http.Request) *http.Response {
	t.Helper()
	client := &http.Client{Timeout: 4 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	return response
}

func mcpHTTPTestRead(t *testing.T, response *http.Response) object {
	t.Helper()
	defer func() { _ = response.Body.Close() }()
	var data []byte
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		reader := bufio.NewReader(response.Body)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(line, "data: ") {
				data = []byte(strings.TrimPrefix(line, "data: "))
				break
			}
		}
	} else {
		var err error
		data, err = io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
	}
	message, err := decodeObject(data)
	if err != nil {
		t.Fatalf("invalid HTTP MCP response %q: %v", data, err)
	}
	return message
}

func mcpHTTPTestInitialize(t *testing.T, h *mcpHTTPServer, token string) string {
	t.Helper()
	response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, token, "", mcpTestRequest(1, "initialize", object{"protocolVersion": value("2025-11-25")}, false)))
	id := response.Header.Get("Mcp-Session-Id")
	if result := mcpHTTPTestRead(t, response).object("result"); id == "" || result.text("protocolVersion") != "2025-11-25" {
		t.Fatalf("legacy initialization failed: %s", value(result))
	}
	return id
}

func TestMCPHTTPProtocolCompatibility(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	for _, revision := range []string{"2025-03-26", "2025-06-18", "2025-11-25"} {
		t.Run(revision, func(t *testing.T) {
			response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(1, "initialize", object{"protocolVersion": value(revision)}, false)))
			session := response.Header.Get("Mcp-Session-Id")
			if mcpHTTPTestRead(t, response).object("result").text("protocolVersion") != revision {
				t.Fatal("wrong negotiated revision")
			}
			request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, session, mcpTestRequest(2, "tools/list", nil, false))
			request.Header.Set("MCP-Protocol-Version", revision)
			if revision == "2025-03-26" {
				request.Header.Del("MCP-Protocol-Version")
			}
			names := mcpTestToolNames(mcpHTTPTestRead(t, mcpHTTPTestDo(t, request)).object("result"))
			if !names["browser_toolset"] || names["browser_skill"] {
				t.Fatalf("wrong legacy tools: %v", names)
			}
		})
	}
	for _, method := range []string{"server/discover", "tools/list", "ping"} {
		response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(1, method, nil, true)))
		if response.Header.Get("Mcp-Session-Id") != "" {
			t.Fatal("modern HTTP minted a protocol session")
		}
		result := mcpHTTPTestRead(t, response).object("result")
		if result.text("resultType") != "complete" {
			t.Fatalf("missing modern result: %s", value(result))
		}
		if method == "tools/list" {
			names := mcpTestToolNames(result)
			if len(names) != 6 || !names["browser_skill"] || names["browser_toolset"] {
				t.Fatalf("wrong modern catalog: %v", names)
			}
		}
	}
	// A modern protocol session header is ignored rather than selecting legacy state.
	request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "not-a-session", mcpTestRequest(2, "ping", nil, true))
	if mcpHTTPTestRead(t, mcpHTTPTestDo(t, request))["error"] != nil {
		t.Fatal("modern request depended on a protocol session")
	}
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(1, "ping", nil, true))
		request.Method = method
		if response := mcpHTTPTestDo(t, request); response.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("modern %s returned %d", method, response.StatusCode)
		}
	}
}

func TestMCPHTTPAuthenticationAndHeaders(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	for _, test := range []struct {
		name   string
		change func(*http.Request)
		status int
		code   int64
	}{
		{"missing credential", func(r *http.Request) { r.Header.Del("Authorization") }, 401, -32600},
		{"wrong credential", func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+strings.Repeat("z", 40)) }, 401, -32600},
		{"native credential", func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 40)) }, 401, -32600},
		{"duplicate authorization", func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+mcpHTTPTokenA) }, 401, -32600},
		{"host", func(r *http.Request) { r.Host = "evil.example:9224" }, 403, -32600},
		{"origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403, -32600},
		{"null origin", func(r *http.Request) { r.Header.Set("Origin", "null") }, 403, -32600},
		{"query token", func(r *http.Request) { r.URL.RawQuery = "token=" + mcpHTTPTokenA }, 400, -32600},
		{"content type", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415, -32600},
		{"accept", func(r *http.Request) { r.Header.Set("Accept", "application/json") }, 406, -32600},
		{"unacceptable quality", func(r *http.Request) { r.Header.Set("Accept", "application/json, text/event-stream;q=0.0") }, 406, -32600},
		{"missing version", func(r *http.Request) { r.Header.Del("MCP-Protocol-Version") }, 400, -32020},
		{"version mismatch", func(r *http.Request) { r.Header.Set("MCP-Protocol-Version", "2025-11-25") }, 400, -32020},
		{"method mismatch", func(r *http.Request) { r.Header.Set("Mcp-Method", "tools/list") }, 400, -32020},
		{"duplicate version", func(r *http.Request) { r.Header.Add("MCP-Protocol-Version", modernVersion) }, 400, -32020},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(1, "ping", nil, true))
			test.change(request)
			response := mcpHTTPTestDo(t, request)
			message := mcpHTTPTestRead(t, response)
			if response.StatusCode != test.status || message.object("error").number("code") != test.code {
				t.Fatalf("status=%d response=%s", response.StatusCode, value(message))
			}
			if strings.Contains(string(value(message)), mcpHTTPTokenA) {
				t.Fatal("credential echoed in response")
			}
		})
	}
	request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestCall(2, "browser_skill", object{}, true))
	request.Header.Set("Mcp-Name", "=?base64?"+base64.StdEncoding.EncodeToString([]byte("browser_skill"))+"?=")
	request.Header.Set("Origin", "http://"+request.URL.Host)
	if mcpHTTPTestRead(t, mcpHTTPTestDo(t, request)).object("result").boolean("isError") {
		t.Fatal("valid encoded tool name rejected")
	}
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Header.Del("Mcp-Name") },
		func(r *http.Request) { r.Header.Set("Mcp-Name", "browser_call") },
		func(r *http.Request) { r.Header.Set("Mcp-Name", "=?base64?invalid!?=") },
	} {
		request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestCall(2, "browser_skill", object{}, true))
		change(request)
		if response := mcpHTTPTestDo(t, request); response.StatusCode != 400 || mcpHTTPTestRead(t, response).object("error").number("code") != -32020 {
			t.Fatal("invalid tool name header accepted")
		}
	}
	message := mcpTestRequest(3, "ping", nil, true)
	params := message.object("params")
	params["_meta"] = value(object{versionKey: value("2030-01-01"), capabilitiesKey: value(object{})})
	message["params"] = value(params)
	response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", message))
	rejection := mcpHTTPTestRead(t, response).object("error")
	if response.StatusCode != 400 || rejection.number("code") != -32022 || rejection.object("data").text("requested") != "2030-01-01" {
		t.Fatal("unsupported version did not provide negotiation evidence")
	}
}

func TestMCPHTTPLegacyIsolationNotificationsAndDelete(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	first := mcpHTTPTestInitialize(t, h, mcpHTTPTokenA)
	second := mcpHTTPTestInitialize(t, h, mcpHTTPTokenA)
	request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, first, mcpTestRequest(1, "ping", nil, false))
	request.Method = http.MethodGet
	stream := mcpHTTPTestDo(t, request)
	response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, first, mcpTestCall(3, "browser_toolset", object{"tool": value("browser_dom")}, false)))
	if !mcpHTTPTestRead(t, response).object("result").object("structuredContent").boolean("newlyEnabled") {
		t.Fatal("legacy tool was not enabled")
	}
	if event := mcpHTTPTestRead(t, stream); event.text("method") != "notifications/tools/list_changed" {
		t.Fatalf("wrong notification: %s", value(event))
	}
	for _, session := range []string{first, second} {
		result := mcpHTTPTestRead(t, mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, session, mcpTestRequest(4, "tools/list", nil, false)))).object("result")
		if mcpTestToolNames(result)["browser_dom"] != (session == first) {
			t.Fatal("legacy tool enablement leaked between owners")
		}
	}
	request = mcpHTTPTestRequest(t, h, mcpHTTPTokenB, first, mcpTestRequest(5, "ping", nil, false))
	if response := mcpHTTPTestDo(t, request); response.StatusCode != 404 {
		t.Fatal("credential stole another client's legacy session")
	}
	request = mcpHTTPTestRequest(t, h, mcpHTTPTokenA, first, mcpTestRequest(6, "ping", nil, false))
	request.Method = http.MethodDelete
	if response := mcpHTTPTestDo(t, request); response.StatusCode != 204 {
		t.Fatal("legacy DELETE failed")
	}
	if response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, first, mcpTestRequest(7, "ping", nil, false))); response.StatusCode != 404 {
		t.Fatal("deleted session resurrected")
	}
	notification := object{"jsonrpc": value("2.0"), "method": value("notifications/initialized")}
	if response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, second, notification)); response.StatusCode != 202 {
		t.Fatal("legacy notification was not accepted")
	}
}

func TestMCPHTTPSubscriptionsExpiryRotationAndLimits(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(1, "subscriptions/listen", object{"notifications": value(object{"toolsListChanged": value(true)})}, true)))
	ack := mcpHTTPTestRead(t, response)
	if ack.text("method") != "notifications/subscriptions/acknowledged" {
		t.Fatalf("wrong subscription acknowledgment: %s", value(ack))
	}
	h.mu.Lock()
	var original *mcpHTTPOwner
	for _, owner := range h.owners {
		original = owner
	}
	h.mu.Unlock()
	h.expire(time.Now().Add(2*time.Hour), false)
	if original == nil || original.ctx.Err() == nil {
		t.Fatal("quiet subscription prevented expiry")
	}
	// A later request receives a new application owner, not revived handles.
	mcpHTTPTestRead(t, mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(2, "ping", nil, true))))
	h.mu.Lock()
	var replacement *mcpHTTPOwner
	for _, owner := range h.owners {
		replacement = owner
	}
	h.mu.Unlock()
	if replacement == nil || replacement == original {
		t.Fatal("expired owner was reused")
	}
	if err := os.WriteFile(h.settings.Clients["first"], []byte(strings.Repeat("c", 40)), 0600); err != nil {
		t.Fatal(err)
	}
	h.expire(time.Now(), false)
	if replacement.ctx.Err() == nil {
		t.Fatal("token rotation did not revoke the owner")
	}
	if response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(3, "ping", nil, true))); response.StatusCode != 401 {
		t.Fatal("old credential remained valid")
	}
	if response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, strings.Repeat("c", 40), "", mcpTestRequest(4, "ping", nil, true))); response.StatusCode != 200 {
		t.Fatal("rotated credential unavailable")
	}
	for i := 0; i < mcpHTTPMaxOwners-1; i++ {
		mcpHTTPTestInitialize(t, h, mcpHTTPTokenB)
	}
	if response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenB, "", mcpTestRequest(5, "initialize", nil, false))); response.StatusCode != 503 {
		t.Fatal("owner limit was not enforced")
	}
}

func TestMCPHTTPRejectsMalformedAndOversizedRequests(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	for _, body := range []string{"{", "[]", `{"jsonrpc":"2.0","id":{},"method":"ping"}`, `{"jsonrpc":"2.0","id":null,"method":"ping"}`, `{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}`, strings.Repeat(" ", maxMessageBytes+1)} {
		request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(1, "ping", nil, true))
		request.Body = io.NopCloser(strings.NewReader(body))
		request.ContentLength = int64(len(body))
		response := mcpHTTPTestDo(t, request)
		if response.StatusCode != 400 && response.StatusCode != 413 {
			t.Fatalf("body accepted with %d", response.StatusCode)
		}
		_ = mcpHTTPTestRead(t, response)
	}
}

func mcpHTTPTestNative(t *testing.T) (config, *daemon, *wireWriter, *bufio.Reader) {
	t.Helper()
	d := serviceTestDaemon(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c := config{home: d.config.home, network: "tcp", address: listener.Addr().String(), token: strings.Repeat("x", 40)}
	d.config, d.agentToken, d.extensionToken = c, c.token, strings.Repeat("e", 40)
	var workers sync.WaitGroup
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			p := &peer{conn: conn, accepted: time.Now(), out: make(chan queuedMessage, 32), done: make(chan struct{}), identity: object{}, owner: uniqueID(), dataTargets: make(map[*peer]bool)}
			d.mu.Lock()
			d.peers[p] = true
			d.mu.Unlock()
			workers.Add(1)
			go func() { defer workers.Done(); d.serve(p) }()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		<-done
		d.mu.Lock()
		for p := range d.peers {
			_ = p.conn.Close()
		}
		d.mu.Unlock()
		workers.Wait()
	})
	writer, reader := serviceWirePeer(t, d, "extension")
	d.mu.Lock()
	for p := range d.peers {
		if p.role == "extension" {
			p.access = true
		}
	}
	d.mu.Unlock()
	return c, d, writer, reader
}

func mcpHTTPTestForwarded(t *testing.T, reader *bufio.Reader) object {
	t.Helper()
	message, err := readLine(reader)
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func TestMCPHTTPOwnershipAndNativeCleanup(t *testing.T) {
	c, d, extension, reader := mcpHTTPTestNative(t)
	h := mcpHTTPTestStart(t, c)
	owners := []string{}
	conversations := []string{}
	for _, conversation := range []string{"ses_first", "ses_second", "ses_first"} {
		call := mcpTestConversationCall(7, "browser_call", object{"method": value("page.get_state"), "tabId": value(1)}, true, value(conversation))
		response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", call))
		forwarded := mcpHTTPTestForwarded(t, reader).object("request")
		owners = append(owners, forwarded.object("meta").text("transport_owner"))
		conversations = append(conversations, forwarded.object("meta").text("agent_session"))
		if err := extension.send(object{"type": value("extension.response"), "response": value(success(forwarded.text("id"), object{}))}); err != nil {
			t.Fatal(err)
		}
		if mcpHTTPTestRead(t, response).object("result").boolean("isError") {
			t.Fatal("read failed")
		}
	}
	if owners[0] == "" || owners[0] != owners[1] || conversations[0] == conversations[1] || conversations[0] != conversations[2] {
		t.Fatal("transport or request-local conversation ownership changed")
	}
	data := []byte("owned artifact")
	artifact := artifactTestDescriptor("h", data)
	d.mu.Lock()
	storeTestArtifact(t, d.artifacts, artifact, data, "http-artifact", owners[0], "extension")
	d.mu.Unlock()
	for _, token := range []string{mcpHTTPTokenB, mcpHTTPTokenA} {
		call := mcpTestCall(8, "browser_call", object{"method": value("artifact.read"), "params": value(object{"artifactId": artifact["artifactId"]})}, true)
		result := mcpHTTPTestRead(t, mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, token, "", call))).object("result")
		if result.boolean("isError") != (token == mcpHTTPTokenB) {
			t.Fatalf("artifact crossed credential ownership: %s", value(result))
		}
	}
	if err := os.Remove(h.settings.Clients["first"]); err != nil {
		t.Fatal(err)
	}
	h.expire(time.Now(), false)
	event := mcpHTTPTestForwarded(t, reader)
	if event.text("type") != "extension.owner_disconnected" || event.text("ownerId") != owners[0] {
		t.Fatalf("missing owner cleanup notification: %s", value(event))
	}
	d.mu.Lock()
	remaining := len(d.artifacts.items)
	d.mu.Unlock()
	if remaining != 0 {
		t.Fatal("revocation retained owned artifacts")
	}
	// Another credential remains usable after the first is revoked.
	if result := mcpHTTPTestRead(t, mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenB, "", mcpTestCall(9, "browser_skill", object{}, true)))); result.object("result").boolean("isError") {
		t.Fatal("revocation affected another client")
	}
}

func TestMCPHTTPCancellationByProtocolEra(t *testing.T) {
	for _, modern := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy", true: "modern"}[modern], func(t *testing.T) {
			c, d, _, reader := mcpHTTPTestNative(t)
			h := mcpHTTPTestStart(t, c)
			session := ""
			if !modern {
				session = mcpHTTPTestInitialize(t, h, mcpHTTPTokenA)
			}
			call := mcpTestCall(7, "browser_call", object{"method": value("input.click"), "tabId": value(1), "params": value(object{"target": value(object{"selector": value("button")})})}, modern)
			request := mcpHTTPTestRequest(t, h, mcpHTTPTokenA, session, call)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request = request.WithContext(ctx)
			completed := make(chan struct{})
			go func() {
				defer close(completed)
				response, err := http.DefaultClient.Do(request)
				if err == nil {
					_, _ = io.Copy(io.Discard, response.Body)
					_ = response.Body.Close()
				}
			}()
			forwarded := mcpHTTPTestForwarded(t, reader).object("request")
			if forwarded.text("method") != "input.click" {
				t.Fatalf("mutation was not dispatched: %s", value(forwarded))
			}
			h.expire(time.Now().Add(2*time.Hour), false)
			h.mu.Lock()
			count := len(h.owners)
			h.mu.Unlock()
			if count != 1 {
				t.Fatal("expiry removed an in-flight owner")
			}
			cancel()
			<-completed
			if !modern {
				// Inspect the live native request after the HTTP client disconnects.
				d.mu.Lock()
				count := len(d.pending)
				d.mu.Unlock()
				if count != 1 {
					t.Fatal("HTTP disconnect canceled legacy work")
				}
				other := mcpHTTPTestInitialize(t, h, mcpHTTPTokenA)
				notification := object{"jsonrpc": value("2.0"), "method": value("notifications/cancelled"), "params": value(object{"requestId": value(7)})}
				_ = mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, other, notification))
				d.mu.Lock()
				count = len(d.pending)
				d.mu.Unlock()
				if count != 1 {
					t.Fatal("another legacy owner canceled the request")
				}
				_ = mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, session, notification))
			}
			canceled := mcpHTTPTestForwarded(t, reader)
			if canceled.text("type") != "extension.request_cancelled" || canceled.text("requestId") != forwarded.text("id") {
				t.Fatalf("wrong cancellation: %s", value(canceled))
			}
		})
	}
}

func TestMCPHTTPModernDuplicateIDsAreIndependent(t *testing.T) {
	c, d, extension, reader := mcpHTTPTestNative(t)
	h := mcpHTTPTestStart(t, c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	call := mcpTestCall(1, "browser_call", object{"method": value("page.get_state"), "tabId": value(1)}, true)
	first := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", call).WithContext(ctx))
	a := mcpHTTPTestForwarded(t, reader).object("request")
	second := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", call))
	b := mcpHTTPTestForwarded(t, reader).object("request")
	cancel()
	_ = first.Body.Close()
	event := mcpHTTPTestForwarded(t, reader)
	if event.text("type") != "extension.request_cancelled" || event.text("requestId") != a.text("id") {
		t.Fatal("canceling one HTTP request affected another with the same RPC ID")
	}
	d.mu.Lock()
	count := len(d.pending)
	d.mu.Unlock()
	if count != 1 {
		t.Fatal("independent HTTP request was canceled")
	}
	if err := extension.send(object{"type": value("extension.response"), "response": value(success(b.text("id"), object{}))}); err != nil {
		t.Fatal(err)
	}
	if result := mcpHTTPTestRead(t, second); result.number("id") != 1 || result.object("result").boolean("isError") {
		t.Fatal("second request failed")
	}
}

func TestMCPHTTPSettingsValidation(t *testing.T) {
	c := config{home: t.TempDir()}
	if settings, err := readMCPHTTPSettings(c); err != nil || settings.Enabled {
		t.Fatal("HTTP was not disabled by default")
	}
	for _, body := range []string{`{"enabled":true,"unknown":1}`, `{"enabled":true} {}`, `{"enabled":true,"listen":"0.0.0.0:9224"}`, `{"enabled":true,"clients":{"test":"relative.token"}}`} {
		if err := os.WriteFile(filepath.Join(c.home, "mcp-http.json"), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readMCPHTTPSettings(c); err == nil {
			t.Fatalf("invalid HTTP settings accepted: %s", body)
		}
	}
	settings := mcpHTTPTestSettings(t)
	settings.Clients["second"] = settings.Clients["first"]
	if err := settings.validate(); err == nil {
		t.Fatal("shared credentials accepted")
	}
	settings = mcpHTTPTestSettings(t)
	c.token = mcpHTTPTokenA
	if h, err := startMCPHTTP(context.Background(), c, settings); err == nil {
		h.close()
		t.Fatal("native bridge credential accepted as an HTTP credential")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(settings.Clients["first"], 0644); err != nil {
			t.Fatal(err)
		}
		if err := settings.validate(); err == nil {
			t.Fatal("public token file accepted")
		}
	}
	// Credential digests, not client-reported identities, select modern owners.
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	owner := h.owner("first", sha256.Sum256([]byte(mcpHTTPTokenA)), "modern/test", modernVersion, true)
	h.release(owner)
	if h.owner("second", sha256.Sum256([]byte(mcpHTTPTokenB)), "modern/test", modernVersion, false) != nil {
		t.Fatal("credential replaced another client's owner")
	}
}

func TestMCPHTTPCallerScopeAndBudgets(t *testing.T) {
	t.Setenv("BBX_AGENT", "daemon-launcher")
	c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
	h := mcpHTTPTestStart(t, c)
	message := mcpTestCall(1, "browser_health", object{}, true)
	params := message.object("params")
	meta := params.object("_meta")
	meta["io.modelcontextprotocol/clientInfo"] = value(object{"name": value("HTTP caller")})
	params["_meta"] = value(meta)
	message["params"] = value(params)
	if result := mcpHTTPTestRead(t, mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", message))); result.object("result").boolean("isError") {
		t.Fatal("HTTP caller dispatch failed")
	}
	forwarded := <-requests
	if caller := forwarded.object("meta").object("caller").text("name"); caller != "HTTP caller" {
		t.Fatalf("daemon environment impersonated HTTP caller: %s", caller)
	}
	h.workers.Wait()
	h.mu.Lock()
	var owner *mcpHTTPOwner
	for _, candidate := range h.owners {
		owner = candidate
	}
	h.mu.Unlock()
	result, err := owner.session.handleTool(context.Background(), "browser_setup", object{"global": value(false)}, "legacy")
	if err != nil || !result.boolean("isError") {
		t.Fatal("HTTP inferred a project directory from the daemon cwd")
	}
	h.mu.Lock()
	owner.calls = 16
	h.mu.Unlock()
	response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestCall(2, "browser_skill", object{}, true)))
	if mcpHTTPTestRead(t, response).object("error").number("code") != -32603 {
		t.Fatal("per-owner call budget not enforced")
	}
	h.workers.Wait()
	h.mu.Lock()
	owner.calls = 0
	owner.streams = 16
	h.mu.Unlock()
	response = mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(3, "subscriptions/listen", object{"notifications": value(object{})}, true)))
	if response.StatusCode != 503 {
		t.Fatal("per-owner stream budget not enforced")
	}
	h.workers.Wait()
	h.mu.Lock()
	owner.streams = 0
	h.active = 128
	h.mu.Unlock()
	response = mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", mcpTestRequest(4, "ping", nil, true)))
	if response.StatusCode != 503 {
		t.Fatal("global admission budget not enforced")
	}
	h.mu.Lock()
	h.active = 0
	h.mu.Unlock()
}

func TestMCPHTTPMaximumLifetimeStopsNewAdmissions(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	digest := sha256.Sum256([]byte(mcpHTTPTokenA))
	owner := h.owner("first", digest, "modern/lifetime", modernVersion, true)
	h.mu.Lock()
	owner.created = time.Now().Add(-2 * time.Hour)
	h.mu.Unlock()
	if h.owner("first", digest, "modern/lifetime", modernVersion, true) != nil {
		t.Fatal("overlapping requests extended an owner's maximum lifetime")
	}
	h.expire(time.Now(), false)
	if owner.ctx.Err() != nil {
		t.Fatal("maximum lifetime interrupted an admitted call")
	}
	h.release(owner)
	h.expire(time.Now(), false)
	if owner.ctx.Err() == nil {
		t.Fatal("maximum-lifetime owner survived after its calls drained")
	}
}

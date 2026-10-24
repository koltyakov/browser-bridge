package bridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type mcpTestPeer struct {
	conn   net.Conn
	reader *bufio.Reader
	writer *wireWriter
}

func mcpTestStart(t *testing.T, c config) *mcpTestPeer {
	t.Helper()
	server, peer := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- mcpServe(ctx, c, server, server) }()
	t.Cleanup(func() {
		cancel()
		_ = peer.Close()
		_ = server.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("MCP server did not shut down")
		}
	})
	return &mcpTestPeer{peer, bufio.NewReader(peer), &wireWriter{out: peer}}
}
func (p *mcpTestPeer) send(t *testing.T, message object) {
	t.Helper()
	_ = p.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if err := p.writer.send(message); err != nil {
		t.Fatal(err)
	}
}
func (p *mcpTestPeer) read(t *testing.T) object {
	t.Helper()
	_ = p.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	message, err := readLine(p.reader)
	if err != nil {
		t.Fatal(err)
	}
	return message
}
func mcpTestRequest(id int, method string, params object, modern bool) object {
	if params == nil {
		params = object{}
	}
	if modern {
		params["_meta"] = value(object{versionKey: value(modernVersion), capabilitiesKey: value(object{})})
	}
	return object{"jsonrpc": value("2.0"), "id": value(id), "method": value(method), "params": value(params)}
}
func mcpTestCall(id int, name string, args object, modern bool) object {
	return mcpTestRequest(id, "tools/call", object{"name": value(name), "arguments": value(args)}, modern)
}
func mcpTestToolNames(result object) map[string]bool {
	var tools []object
	_ = json.Unmarshal(result["tools"], &tools)
	names := map[string]bool{}
	for _, tool := range tools {
		names[tool.text("name")] = true
	}
	return names
}

func TestMCPLegacyToolsAreConnectionScoped(t *testing.T) {
	c := config{home: t.TempDir()}
	first, second := mcpTestStart(t, c), mcpTestStart(t, c)
	for _, peer := range []*mcpTestPeer{first, second} {
		peer.send(t, mcpTestRequest(1, "initialize", object{"protocolVersion": value("2025-11-25")}, false))
		initialized := peer.read(t).object("result")
		if !initialized.object("capabilities").object("tools").boolean("listChanged") {
			t.Fatal("legacy listChanged capability missing")
		}
		peer.send(t, mcpTestRequest(2, "tools/list", nil, false))
		names := mcpTestToolNames(peer.read(t).object("result"))
		if !names["browser_toolset"] || names["browser_dom"] {
			t.Fatalf("wrong initial tools: %v", names)
		}
	}
	first.send(t, mcpTestCall(3, "browser_toolset", object{"tool": value("browser_dom")}, false))
	if !first.read(t).object("result").object("structuredContent").boolean("newlyEnabled") {
		t.Fatal("tool not loaded")
	}
	if first.read(t).text("method") != "notifications/tools/list_changed" {
		t.Fatal("missing tool-list notification")
	}
	for i, peer := range []*mcpTestPeer{first, second} {
		peer.send(t, mcpTestRequest(4, "tools/list", nil, false))
		names := mcpTestToolNames(peer.read(t).object("result"))
		if names["browser_dom"] != (i == 0) {
			t.Fatalf("tool enablement leaked between connections: %v", names)
		}
	}
}

func BenchmarkMCPLegacyTools(b *testing.B) {
	s := &mcpSession{enabled: map[string]bool{"browser_dom": true}}
	b.ReportAllocs()
	for b.Loop() {
		if len(s.tools("legacy")) == 0 {
			b.Fatal("missing tools")
		}
	}
}

func BenchmarkMCPBatchShaping(b *testing.B) {
	nodes := make([]object, 20)
	for i := range nodes {
		nodes[i] = object{"elementRef": value(fmt.Sprintf("el_%d", i)), "tag": value("a"), "textExcerpt": value("Documentation"), "attrs": value(object{"href": value("/docs"), "class": value("link primary")})}
	}
	response := success("batch", object{"nodes": value(nodes)})
	params := object{"maxNodes": value(20)}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		for range 20 {
			if !mcpBatchResult(response, "dom.query", params, nil, 3).boolean("ok") {
				b.Fatal("shaping failed")
			}
		}
	}
}

func TestMCPModernFixedToolsAndEnvelope(t *testing.T) {
	peer := mcpTestStart(t, config{home: t.TempDir()})
	peer.send(t, mcpTestRequest(0, "server/discover", nil, true))
	discovery := peer.read(t).object("result")
	if discovery.text("resultType") != "complete" || discovery.text("instructions") != catalog.Instructions || discovery.object("_meta").object("io.modelcontextprotocol/serverInfo").text("name") != "browser-bridge" {
		t.Fatalf("invalid modern discovery: %s", value(discovery))
	}
	peer.send(t, mcpTestRequest(1, "tools/list", nil, true))
	names := mcpTestToolNames(peer.read(t).object("result"))
	if len(names) != 6 || !names["browser_skill"] || names["browser_toolset"] {
		t.Fatalf("wrong modern tools: %v", names)
	}
	peer.send(t, mcpTestCall(2, "browser_toolset", object{"tool": value("browser_dom")}, true))
	if peer.read(t).object("error").number("code") != -32602 {
		t.Fatal("modern toolset load was accepted")
	}
	peer.send(t, mcpTestRequest(3, "tools/list", nil, false))
	if peer.read(t).object("error").number("code") != -32602 {
		t.Fatal("missing per-request envelope was accepted")
	}
	peer.send(t, mcpTestCall(4, "browser_skill", object{}, true))
	if !peer.read(t).object("result").object("structuredContent").boolean("ok") {
		t.Fatal("local runtime context unavailable")
	}
}

func TestMCPModernSubscriptionContract(t *testing.T) {
	var expected []object
	if err := json.Unmarshal(readContractFixture(t, "mcp-subscriptions"), &expected); err != nil {
		t.Fatal(err)
	}
	if len(expected) != 5 {
		t.Fatal("expected acknowledgments, invalid-filter error, ping, and graceful completion")
	}
	peer := mcpTestStart(t, config{home: t.TempDir()})
	filters := []object{{"toolsListChanged": value(true), "promptsListChanged": value(true), "resourceSubscriptions": value([]string{"file:///example"})}, {}, {"toolsListChanged": value("invalid")}}
	for i, filter := range filters {
		peer.send(t, mcpTestRequest(i+1, "subscriptions/listen", object{"notifications": value(filter)}, true))
		actual := peer.read(t)
		assertJSONEqual(t, value(actual), value(expected[i]))
	}
	peer.send(t, object{"jsonrpc": value("2.0"), "method": value("notifications/cancelled"), "params": value(object{"requestId": value(2)})})
	peer.send(t, mcpTestRequest(4, "ping", nil, true))
	// The SDK rejected modern ping; Go supports it. Both must reply to ping
	// next, without emitting a result for the cancelled subscription.
	ping := peer.read(t)
	if ping.number("id") != expected[3].number("id") || ping["error"] != nil || ping.object("result").object("_meta").object("io.modelcontextprotocol/serverInfo").text("name") != "browser-bridge" {
		t.Fatalf("unexpected response after subscription cancellation: %s", value(ping))
	}
	// SDK closes only the remaining subscription and stamps its original ID.
	var buffer bytes.Buffer
	subscriptions := mcpSubscriptions{"1": value(1)}
	subscriptions.close(&wireWriter{out: &buffer})
	actual, err := decodeObject(buffer.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, value(actual), value(expected[4]))
}

func mcpTestDaemon(t *testing.T, handler func(object) object) (config, <-chan object) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	requests := make(chan object, 32)
	var connections sync.Map
	t.Cleanup(func() {
		_ = listener.Close()
		connections.Range(func(key, value interface{}) bool { _ = key.(net.Conn).Close(); return true })
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			connections.Store(conn, true)
			go func() {
				defer func() { _ = conn.Close() }()
				defer connections.Delete(conn)
				reader := bufio.NewReader(conn)
				_, err := readLine(reader)
				if err != nil {
					return
				}
				writer := &wireWriter{out: conn}
				_ = writer.send(object{"type": value("registered"), "role": value("agent")})
				for {
					message, err := readLine(reader)
					if err != nil {
						return
					}
					request := message.object("request")
					if request == nil {
						continue
					}
					requests <- request
					go func(request object) {
						result := handler(request)
						if result == nil {
							return
						}
						result["id"] = request["id"]
						_ = writer.send(object{"type": value("agent.response"), "response": value(result)})
					}(request)
				}
			}()
		}
	}()
	return config{home: t.TempDir(), network: "tcp", address: listener.Addr().String(), token: strings.Repeat("x", 32)}, requests
}

func TestMCPCancellationPreservesSharedConnection(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "page.get_text" {
			return nil
		}
		return success(request.text("id"), object{"daemon": value("ok")})
	})
	peer := mcpTestStart(t, c)
	peer.send(t, mcpTestCall(1, "browser_call", object{"method": value("page.get_text"), "tabId": value(23), "extensionId": value("profile-a")}, true))
	var request object
	select {
	case request = <-requests:
	case <-time.After(3 * time.Second):
		t.Fatal("call not dispatched")
	}
	meta := request.object("meta")
	if meta.text("mcp_era") != "modern" || meta.text("target_extension") != "profile-a" || meta.text("agent_session") == "" {
		t.Fatalf("routing or ownership missing: %s", value(request))
	}
	peer.send(t, object{"jsonrpc": value("2.0"), "method": value("notifications/cancelled"), "params": value(object{"requestId": value(1)})})
	if !peer.read(t).object("result").boolean("isError") {
		t.Fatal("cancelled call succeeded")
	}
	peer.send(t, mcpTestCall(2, "browser_health", object{}, true))
	if !peer.read(t).object("result").object("structuredContent").boolean("ok") {
		t.Fatal("cancellation closed the shared connection")
	}
}

func TestMCPDestinationRoutingAndProfileDiscovery(t *testing.T) {
	remote, remoteRequests := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "health.ping" {
			return success(request.text("id"), object{"daemon": value("ok"), "connectedExtensions": value([]object{{"extensionId": value("profile-a"), "accessEnabled": value(true)}, {"extensionId": value("profile-b"), "accessEnabled": value(true)}, {"extensionId": value("disabled"), "accessEnabled": value(false)}})})
		}
		profile := request.object("meta").text("target_extension")
		if profile == "profile-b" {
			return failure(request.text("id"), "ACCESS_DENIED", "Window closed.")
		}
		return success(request.text("id"), object{"tabs": value([]object{{"tabId": value(7), "title": value("Example"), "active": value(true)}})})
	})
	local, localRequests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{}) })
	host, port, err := net.SplitHostPort(remote.address)
	if err != nil {
		t.Fatal(err)
	}
	var portNumber int
	_, _ = fmt.Sscan(port, &portNumber)
	configBytes := value(remoteConfig{Remotes: []remoteDestination{{ID: "remote", Host: host, Port: portNumber, Token: strings.Repeat("x", 32)}}})
	if err := os.WriteFile(filepath.Join(local.home, "remotes.json"), configBytes, 0600); err != nil {
		t.Fatal(err)
	}
	s := &mcpSession{config: local, agentSession: "routing-test"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	result, err := s.handleTool(context.Background(), "browser_call", object{"method": value("tabs.list"), "destinationId": value("remote")}, "modern")
	if err != nil || result.boolean("isError") {
		t.Fatalf("discovery failed: %v %s", err, value(result))
	}
	evidence := result.object("structuredContent").object("evidence")
	var tabs []object
	_ = json.Unmarshal(evidence["tabs"], &tabs)
	if !evidence.boolean("partial") || len(tabs) != 1 || tabs[0].text("extensionId") != "profile-a" {
		t.Fatalf("profile discovery lost provenance or failures: %s", value(evidence))
	}
	if len(remoteRequests) != 3 {
		t.Fatalf("expected health and two enabled profiles, got %d requests", len(remoteRequests))
	}
	select {
	case request := <-localRequests:
		t.Fatalf("remote call leaked to local daemon: %s", value(request))
	default:
	}
}

func TestMCPOnlyReadCallsRetry(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		response := failure(request.text("id"), "TIMEOUT", "Retryable failure.")
		e := response.object("error")
		e["recovery"] = value(object{"retry": value(true), "retryAfterMs": value(0)})
		response["error"] = value(e)
		return response
	})
	s := &mcpSession{config: c, agentSession: "retry-test"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	_, err := s.handleTool(context.Background(), "browser_call", object{"method": value("page.get_state"), "tabId": value(3)}, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	first, second := <-requests, <-requests
	if first.object("meta")["automatic_retry"] != nil || second.object("meta").object("automatic_retry").number("attempt") != 2 {
		t.Fatal("read retry metadata is missing")
	}
	_, err = s.handleTool(context.Background(), "browser_call", object{"method": value("input.click"), "tabId": value(3), "params": value(object{"target": value(object{"selector": value("#save")})})}, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 {
		t.Fatalf("mutation was retried: %d requests", len(requests))
	}
}

func TestMCPTypedInputIsAtomicAndBatchRejectsMutations(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object { return success(request.text("id"), object{"clicked": value(true)}) })
	s := &mcpSession{config: c, agentSession: "test-session"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	result, err := s.handleTool(context.Background(), "browser_input", object{"action": value("click"), "selector": value("#save"), "locator": value(object{"role": value("button"), "name": value("Save")}), "tabId": value(7)}, "legacy")
	if err != nil || result.boolean("isError") {
		t.Fatalf("click failed: %v %s", err, value(result))
	}
	request := <-requests
	if request.text("method") != "input.click" || request.object("params").object("target").text("role") != "button" {
		t.Fatalf("input was not atomic: %s", value(request))
	}
	result, err = s.batch(context.Background(), object{"calls": value([]object{{"method": value("input.click")}})}, "legacy")
	if err != nil || !result.boolean("isError") {
		t.Fatal("batch accepted a mutating call")
	}
	select {
	case request := <-requests:
		t.Fatalf("rejected batch dispatched request: %s", value(request))
	default:
	}
}

func TestMCPExactPayloadsAndBoundedEvidence(t *testing.T) {
	image := mcpResponse(success("x", object{"image": value("data:image/png;base64,aGVsbG8="), "complete": value(true)}), "screenshot.capture_region", object{})
	var content []object
	_ = json.Unmarshal(image["content"], &content)
	if len(content) != 2 || content[1].text("data") != "aGVsbG8=" || content[1].text("mimeType") != "image/png" {
		t.Fatalf("inline image missing: %s", value(image))
	}
	secret := strings.Repeat("private", 2000)
	sensitive := mcpResponse(success("x", object{"source": value("local_storage"), "value": value(secret), "exact": value(true)}), "sensitive.read", object{})
	structured := sensitive.object("structuredContent")
	if structured.text("value") != secret || structured["deliveredBytes"] != nil {
		t.Fatal("sensitive read was truncated or measured")
	}
	chunk := strings.Repeat("a", 32000)
	artifact := mcpResponse(success("x", object{"artifactId": value("artifact"), "data": value(chunk), "offset": value(0), "byteLength": value(24000), "totalBytes": value(24000), "nextOffset": value[*int](nil), "sha256": value(strings.Repeat("a", 64))}), "artifact.read", object{})
	if artifact.object("structuredContent").text("data") != chunk {
		t.Fatal("artifact bytes were bounded")
	}
	text := strings.Repeat("x", 12000)
	result := mcpResponse(success("x", object{"text": value(text)}), "page.get_text", object{"textBudget": value(8000)}).object("structuredContent")
	if len(result.object("evidence").text("text")) != 8000 || !result.boolean("outputTruncated") {
		t.Fatal("requested evidence budget not honored")
	}
	web := mcpResponse(success("x", object{"schema": value(strings.Repeat("x", 10000))}), "webmcp.get_tool", object{})
	if len(web.object("structuredContent").object("evidence").text("schema")) != 10000 {
		t.Fatal("atomic WebMCP schema was bounded")
	}
}

func TestMCPControlAcceptsAuthenticatedRestart(t *testing.T) {
	c := config{home: t.TempDir()}
	cancelled := make(chan struct{}, 1)
	dispose := startMCPControl(c, func() { cancelled <- struct{}{} })
	defer dispose()
	// The registry is also consumed by bbx restart; exercise that public flow.
	result, err := restartMCPProcesses(c)
	if err != nil || result.number("restartRequested") != 1 {
		t.Fatalf("restart control failed: %v %s", err, value(result))
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("restart callback not called")
	}
}

func TestMCPRestartRemovesClosedEndpointWithReusedPID(t *testing.T) {
	c := config{home: t.TempDir()}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(c.home, "mcp-processes")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	registration := filepath.Join(dir, "stale.json")
	data := object{"protocolVersion": value(1), "instanceId": value("stale"), "pid": value(os.Getpid()), "port": value(port), "token": value("obsolete")}
	if err := os.WriteFile(registration, value(data), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := restartMCPProcesses(c)
	if err != nil || result.number("restartFailed") != 0 || result.number("restartRequested") != 0 || result.number("staleRegistrationsRemoved") != 1 {
		t.Fatalf("stale endpoint retained: %v %s", err, value(result))
	}
	if _, err := os.Stat(registration); !os.IsNotExist(err) {
		t.Fatalf("registration still exists: %v", err)
	}
}

func TestSchemaUnionsAndRecords(t *testing.T) {
	var schema object
	_ = json.Unmarshal([]byte(`{"type":"object","properties":{"observe":{"anyOf":[{"type":"boolean"},{"type":"object","properties":{"settleMs":{"type":"integer","minimum":0}},"additionalProperties":false}]},"headers":{"type":"object","additionalProperties":{"type":"string"}}},"additionalProperties":false}`), &schema)
	for _, valid := range []string{`{"observe":true}`, `{"observe":{"settleMs":10},"headers":{"Accept":"text/html"}}`} {
		if err := validateSchema([]byte(valid), schema, "arguments"); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []string{`{"observe":3}`, `{"observe":{"settleMs":-1}}`, `{"headers":{"Accept":4}}`} {
		if validateSchema([]byte(invalid), schema, "arguments") == nil {
			t.Fatalf("invalid arguments accepted: %s", invalid)
		}
	}
}

func TestMCPOversizedRequestFailsWithoutEndingTheSession(t *testing.T) {
	for _, size := range []int{maxMessageBytes, maxMessageBytes + 64*1024} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			var output bytes.Buffer
			input := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}` + "\n" +
				`{"jsonrpc":"2.0","id":2,"method":"ping","params":{"pad":"` + strings.Repeat("x", size) + `"}}` + "\n" +
				`{"jsonrpc":"2.0","id":3,"method":"ping"}` + "\n"
			if err := mcpServe(context.Background(), config{home: t.TempDir()}, strings.NewReader(input), &output); err != nil {
				t.Fatalf("oversized request ended the MCP session: %v", err)
			}
			lines := strings.Split(strings.TrimSpace(output.String()), "\n")
			if len(lines) != 3 || !strings.Contains(lines[1], `"code":-32600`) || !strings.Contains(lines[2], `"id":3`) {
				t.Fatalf("unexpected responses: %q", lines)
			}
		})
	}
}

func TestMCPOversizedBatchResultPreservesSessionAndAtomicEvidence(t *testing.T) {
	for _, modern := range []bool{false, true} {
		t.Run(fmt.Sprintf("modern=%t", modern), func(t *testing.T) {
			description := strings.Repeat("x", 60_000)
			c, _ := mcpTestDaemon(t, func(request object) object {
				return success(request.text("id"), object{"toolRef": value("tool_1"), "inputSchema": value(object{"type": value("object"), "description": value(description)})})
			})
			peer := mcpTestStart(t, c)
			if !modern {
				peer.send(t, mcpTestRequest(0, "initialize", object{"protocolVersion": value("2025-11-25")}, false))
				peer.read(t)
			}
			calls := make([]object, 20)
			for i := range calls {
				calls[i] = object{"method": value("webmcp.get_tool"), "tabId": value(7), "params": value(object{"toolRef": value("tool_1")})}
			}
			peer.send(t, mcpTestCall(1, "browser_batch", object{"calls": value(calls)}, modern))
			result := peer.read(t).object("result")
			if !result.boolean("isError") || result.object("structuredContent").object("error").text("code") != "RESULT_TOO_LARGE" {
				t.Fatalf("oversized output did not return a typed error: %s", value(result))
			}
			peer.send(t, mcpTestRequest(2, "ping", nil, modern))
			if ping := peer.read(t); ping.number("id") != 2 || ping["error"] != nil {
				t.Fatalf("oversized output broke the MCP session: %s", value(ping))
			}
			peer.send(t, mcpTestCall(3, "browser_batch", object{"calls": value(calls[:1])}, modern))
			small := peer.read(t).object("result")
			var items []object
			_ = json.Unmarshal(small.object("structuredContent")["results"], &items)
			if small.boolean("isError") || len(items) != 1 || items[0].object("evidence").object("inputSchema").text("description") != description {
				t.Fatal("smaller batch truncated atomic schema evidence")
			}
		})
	}
}

func TestMCPQueryEvidenceTreatsNullFieldsAsMissing(t *testing.T) {
	node := object{"elementRef": value("el_1"), "tag": value("button"), "role": value[*string](nil), "name": value[*string](nil), "attrs": value(object{"role": value("tab"), "aria-label": value("Settings")})}
	evidence := mcpResponse(success("q", object{"nodes": value([]object{node, {"elementRef": value("el_2"), "tag": value("a"), "role": value[*string](nil)}})}), "dom.query", object{}).object("structuredContent")["evidence"]
	var nodes []object
	if err := json.Unmarshal(evidence, &nodes); err != nil || len(nodes) != 2 {
		t.Fatalf("unexpected evidence: %s", evidence)
	}
	if nodes[0].text("role") != "tab" || nodes[0].text("label") != "Settings" {
		t.Fatalf("null node fields blocked attribute fallback: %s", value(nodes[0]))
	}
	if _, ok := nodes[1]["role"]; ok {
		t.Fatalf("null field was delivered: %s", value(nodes[1]))
	}
}

func TestMCPBatchDescribesLocallyAndCompactsItems(t *testing.T) {
	c, requests := mcpTestDaemon(t, func(request object) object {
		response := success(request.text("id"), object{"nodes": value([]object{{"elementRef": value("el_1"), "tag": value("a"), "text": value("Docs")}})})
		response["meta"] = value(object{"protocol_version": value(protocolVersion()), "timing": value(object{"totalMs": value(3), "scheduled": value(false)})})
		return response
	})
	s := &mcpSession{config: c, agentSession: "batch-test"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	result, err := s.batch(context.Background(), object{"extensionId": value("ext-1"), "calls": value([]object{
		{"method": value("protocol.describe"), "params": value(object{"method": value("dom.query")})},
		{"method": value("dom.query"), "tabId": value(4), "params": value(object{"selector": value("a")})},
	})}, "legacy")
	if err != nil || result.boolean("isError") {
		t.Fatalf("batch failed: %v %s", err, value(result))
	}
	var items []object
	_ = json.Unmarshal(result.object("structuredContent")["results"], &items)
	if len(items) != 2 || !items[0].boolean("ok") || items[0].object("evidence").text("method") != "dom.query" {
		t.Fatalf("protocol.describe was not answered locally: %s", value(items))
	}
	if request := <-requests; request.text("method") != "dom.query" || len(requests) != 0 {
		t.Fatalf("unexpected bridge traffic: %s", value(request))
	}
	query := items[1]
	for _, key := range []string{"destinationId", "error", "meta", "timing", "extensionId", "transportTokens", "summaryBytes"} {
		if _, ok := query[key]; ok {
			t.Fatalf("batch item kept redundant %s: %s", key, value(query))
		}
	}
	single := mcpResponse(success("q", object{"nodes": value([]object{{"elementRef": value("el_1"), "tag": value("a"), "text": value("Docs")}})}), "dom.query", object{"selector": value("a")}).object("structuredContent")
	if !jsonEqual(query["evidence"], single["evidence"]) || query.number("tabId") != 4 || query["approxTokens"] == nil || query["durationMs"] == nil {
		t.Fatalf("batch evidence differs from browser_call: %s vs %s", value(query), single["evidence"])
	}
	rejected, _ := s.batch(context.Background(), object{"calls": value([]object{{"method": value("input.click")}})}, "legacy")
	var content []object
	_ = json.Unmarshal(rejected["content"], &content)
	if text := content[0].text("text"); !strings.Contains(text, "browser_call") || strings.Contains(text, "Malformed") {
		t.Fatalf("rejection hint is misleading: %s", text)
	}
}

func TestMCPBatchEvidenceMatchesSingleCall(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		response     object
		params       object
		err          error
	}{
		{"text", "page.get_text", success("x", object{"value": value(strings.Repeat("text", 100)), "length": value(900)}), object{"textBudget": value(80)}, nil},
		{"console", "page.get_console", success("x", object{"entries": value([]object{{"text": value("first")}, {"text": value("second")}})}), object{"limit": value(1)}, nil},
		{"tabs", "tabs.list", success("x", object{"tabs": value([]object{{"tabId": value(1)}, {"tabId": value(2)}})}), object{"limit": value(1)}, nil},
		{"outline", "dom.get_accessibility_tree", success("x", object{"nodes": value([]object{{"ref": value("el_1"), "role": value("button"), "name": value("Save")}}), "source": value("dom"), "count": value(1), "truncated": value(false)}), object{}, nil},
		{"failure", "dom.describe", object{"ok": value(false), "error": value(object{"code": value("ELEMENT_STALE"), "message": value("Detached element"), "details": value(object{"text": value(strings.Repeat("x", 5000))})})}, object{}, nil},
		{"transport", "page.get_state", nil, object{}, fmt.Errorf("connection unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item := mcpBatchResult(tc.response, tc.method, tc.params, tc.err, 3)
			response := tc.response
			if tc.err != nil {
				response = failure("batch_error", "INTERNAL_ERROR", tc.err.Error())
			}
			single := mcpResponse(response, tc.method, tc.params).object("structuredContent")
			for _, key := range []string{"ok", "summary", "evidence", "evidenceMeta", "pagination", "error", "recovery", "outputTruncated", "outputLimit"} {
				if item[key] == nil && single[key] == nil {
					continue
				}
				if !jsonEqual(item[key], single[key]) {
					t.Fatalf("batch %s differs from single call: %s vs %s", key, item[key], single[key])
				}
			}
			if item.number("durationMs") != 3 || item["approxTokens"] == nil {
				t.Fatalf("batch metrics missing: %s", value(item))
			}
			for _, key := range []string{"response", "content", "deliveredBytes", "deliveredTokens", "deliveredCostClass", "transportTokens", "summaryBytes"} {
				if item[key] != nil {
					t.Fatalf("redundant batch metric %s: %s", key, value(item))
				}
			}
		})
	}
}

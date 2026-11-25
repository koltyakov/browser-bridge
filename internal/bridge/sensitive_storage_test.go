package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	sensitiveRecordCanary = "BBX_GO_IDB_CANARY_17c4"
	sensitiveDatabaseName = "bbx_go_database_name_2b7e"
	sensitiveStoreName    = "bbx_go_store_name_4c1a"
)

func indexedDBReadParams() object {
	return object{"source": value("indexeddb"), "database": value(sensitiveDatabaseName), "store": value(sensitiveStoreName), "key": json.RawMessage(`["team",7]`), "frameId": value(3)}
}

func indexedDBReadResult(record json.RawMessage) object {
	return object{"source": value("indexeddb"), "frameId": value(3), "database": value(sensitiveDatabaseName), "store": value(sensitiveStoreName), "value": record, "described": value(1), "bytes": value(len(record)), "exact": value(true)}
}

func TestStorageShortcutRejectsKeysForMetadataTypes(t *testing.T) {
	for _, args := range [][]string{{"storage", "indexeddb", "db"}} {
		if _, err := parseCLI(args); err == nil || !strings.Contains(err.Error(), "takes no keys") {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestStorageSummariesListMetadataWithoutValues(t *testing.T) {
	records := success("x", object{
		"type": value("indexeddb"),
		"frames": value([]object{{
			"frameId": value(0), "origin": value("https://app.example.com"), "available": value(true), "total": value(1), "incomplete": value([]string{"time_budget"}),
			"databases": value([]object{{"name": value("app"), "version": value(3), "storeCount": value(1), "stores": value([]object{{
				"name": value("users"), "keyPath": value("id"), "autoIncrement": value(false), "count": json.RawMessage("null"),
				"indexes": value([]object{{"name": value("byName"), "keyPath": value("name"), "unique": value(false), "multiEntry": value(false)}}),
				"records": value([]string{sensitiveRecordCanary}),
			}})}}),
		}}),
		"incompleteFrames": value([]int{5}),
	})
	summary := cliPrintedSummary(records, "", 1700000000000)
	text := value(summary).String()
	if !strings.Contains(summary.text("summary"), "IndexedDB: 1 database(s) across 1 frame(s)") || !strings.Contains(summary.text("summary"), "Incomplete") || strings.Contains(text, sensitiveRecordCanary) || !strings.Contains(text, `"indexes":["byName"]`) || !strings.Contains(text, `"incompleteFrames":[5]`) {
		t.Fatalf("IndexedDB summary: %s", text)
	}
}

func TestIndexedDBReadsAreNeverBatchedRetriedOrSummarized(t *testing.T) {
	for _, params := range []object{indexedDBReadParams()} {
		batch, _ := json.Marshal([]object{{"method": value("sensitive.read"), "params": value(params)}})
		if _, invalid, err := prepareCLIBatch(batch, ""); err != nil || len(invalid) != 1 || invalid[0] == nil || !strings.Contains(value(invalid[0]).String(), "never allowed in batch") {
			t.Fatalf("CLI batch accepted %s: %v %s", params.text("source"), err, value(invalid))
		}
		if batchSafe("sensitive.read", params) || mcpRetrySafe("sensitive.read", params) {
			t.Fatalf("%s reads are batch or retry safe", params.text("source"))
		}
	}
	if !batchSafe("page.get_storage", object{"type": value("indexeddb")}) {
		t.Fatal("metadata listing is no longer an ordinary batch-safe read")
	}

	c, requests := mcpTestDaemon(t, func(request object) object {
		response := failure(request.text("id"), "TIMEOUT", "Retryable failure.")
		e := response.object("error")
		e["recovery"] = value(object{"retry": value(true), "retryAfterMs": value(0)})
		response["error"] = value(e)
		return response
	})
	s := &mcpSession{config: c, agentSession: "sensitive-storage"}
	t.Cleanup(func() {
		for _, cl := range s.clients {
			cl.close()
		}
	})
	for _, args := range []object{
		{"source": value("indexeddb"), "database": value("app"), "store": value("users"), "key": json.RawMessage(`{"type":"date","value":1700000000000}`), "frameId": value(2), "tabId": value(3)},
	} {
		if _, err := s.handleTool(context.Background(), "browser_sensitive_read", args, "modern"); err != nil {
			t.Fatal(err)
		}
		request := <-requests
		params := request.object("params")
		for key := range args {
			if key != "tabId" && !jsonEqual(params[key], args[key]) {
				t.Fatalf("MCP did not forward %s exactly: %s", key, value(request))
			}
		}
		select {
		case retried := <-requests:
			t.Fatalf("%s read was retried: %s", args.text("source"), value(retried))
		case <-time.After(300 * time.Millisecond):
		}
		result, err := s.batch(context.Background(), object{"calls": value([]object{{"method": value("sensitive.read"), "params": value(args)}})}, "modern")
		if err != nil || !result.boolean("isError") {
			t.Fatalf("MCP batch accepted a %s read", args.text("source"))
		}
	}

	big := strings.Repeat(sensitiveRecordCanary, 2000)
	record := json.RawMessage(`{"user":"` + big + `","blob":{"$bbxType":"Blob","mimeType":"image/png","size":9}}`)
	for _, tc := range []struct {
		result object
		field  string
		want   string
	}{
		{indexedDBReadResult(record), "value", string(record)},
	} {
		response := success("x", tc.result)
		response["meta"] = value(object{"method": value("sensitive.read")})
		mcp := mcpResponse(response, "sensitive.read", object{}).object("structuredContent")
		if !jsonEqual(mcp[tc.field], json.RawMessage(tc.want)) || mcp["evidence"] != nil || mcp["deliveredBytes"] != nil {
			t.Fatalf("MCP summarized or truncated %s: %.200s", tc.result.text("source"), value(mcp))
		}
		var out, stderr bytes.Buffer
		if err := writeCLIResponse(response, true, "sensitive.read", 0, &out, &stderr, false, false); err != nil {
			t.Fatal(err)
		}
		var printed object
		if err := json.Unmarshal(out.Bytes(), &printed); err != nil || !jsonEqual(printed[tc.field], json.RawMessage(tc.want)) {
			t.Fatalf("CLI did not print the exact %s: %v", tc.result.text("source"), err)
		}
	}
	nullRecord := indexedDBReadResult(json.RawMessage("null"))
	if mcpResponse(success("x", nullRecord), "sensitive.read", object{}).boolean("isError") {
		t.Fatal("a stored null record was rejected")
	}
	for _, broken := range []object{
		{"source": value("indexeddb"), "frameId": value(0), "database": value("d"), "store": value("s"), "described": value(0), "bytes": value(1), "exact": value(true)},
		{"source": value("indexeddb"), "frameId": value(-1), "database": value("d"), "store": value("s"), "value": value(1), "described": value(0), "bytes": value(1), "exact": value(true)},
		{"source": value("indexeddb"), "frameId": value(0), "database": value("d"), "store": value("s"), "value": value(1), "described": value(0), "bytes": value(1), "exact": value(false)},
	} {
		if !mcpResponse(success("x", broken), "sensitive.read", object{}).boolean("isError") {
			t.Fatalf("invalid sensitive result accepted: %s", value(broken))
		}
	}
}

func TestBrowserSensitiveReadSchemaAcceptsEverySourceLocator(t *testing.T) {
	s := &mcpSession{enabled: map[string]bool{"browser_sensitive_read": true}}
	for _, arguments := range []string{
		`{"source":"local_storage","key":"token"}`,
		`{"source":"response_body","requestId":"1.2"}`,
		`{"source":"indexeddb","database":"app","store":"users","key":7,"frameId":0}`,
		`{"source":"indexeddb","database":"app","store":"users","key":["team",{"type":"date","value":0}]}`,
	} {
		params := object{"name": value("browser_sensitive_read"), "arguments": json.RawMessage(arguments)}
		if _, _, _, failure := s.prepareCall(context.Background(), params, "legacy"); failure != nil {
			t.Fatalf("%s rejected: %s", arguments, value(failure))
		}
	}
	for _, arguments := range []string{
		`{"source":"cache","url":"/"}`,
		`{"source":"indexeddb","database":"app","store":"users","key":true}`,
		`{"source":"cookie","name":"sid","partitioned":"yes"}`,
	} {
		params := object{"name": value("browser_sensitive_read"), "arguments": json.RawMessage(arguments)}
		if _, _, _, failure := s.prepareCall(context.Background(), params, "legacy"); failure == nil {
			t.Fatalf("%s accepted", arguments)
		}
	}
	for _, params := range []object{indexedDBReadParams()} {
		if err := validateMethodParams("sensitive.read", params); err != nil {
			t.Fatalf("daemon schema rejected %s: %v", params.text("source"), err)
		}
	}
	if err := validateMethodParams("page.get_storage", object{"type": value("indexeddb")}); err != nil {
		t.Fatal(err)
	}
}

func TestIndexedDBReadsAreRefusedOverRemoteTransport(t *testing.T) {
	for _, params := range []object{indexedDBReadParams()} {
		d := sensitiveTestDaemon(t)
		d.config.network, d.config.bind = "tcp", "127.0.0.1:9223"
		d.config.proxyTransport = true
		_, extensionReader := serviceWirePeer(t, d, "extension")
		server, client := sensitiveTCPPair(t)
		agent, agentReader := sensitiveWirePeer(t, d, "agent", server, client)
		response := sendSensitiveRequest(t, agent, agentReader, extensionReader, params, false)
		e := response.object("error")
		details := e.object("details")
		if e.text("code") != "ACCESS_DENIED" || details.text("reason") != "remote_sensitive_reads_disabled" || details.text("source") != params.text("source") || string(details["dispatched"]) != "false" {
			t.Fatalf("remote %s: %s", params.text("source"), value(response))
		}
		if text := value(response).String(); strings.Contains(text, sensitiveDatabaseName) {
			t.Fatalf("remote refusal echoed a locator: %s", text)
		}
	}
	// Metadata listing is not a value read and stays available remotely.
	d := sensitiveTestDaemon(t)
	d.config.network, d.config.bind, d.config.proxyTransport = "tcp", "127.0.0.1:9223", true
	_, extensionReader := serviceWirePeer(t, d, "extension")
	server, client := sensitiveTCPPair(t)
	agent, _ := sensitiveWirePeer(t, d, "agent", server, client)
	if err := agent.send(object{"type": value("agent.request"), "request": value(newRequest("page.get_storage", object{"type": value("indexeddb")}, nil, 0))}); err != nil {
		t.Fatal(err)
	}
	if message, err := readLine(extensionReader); err != nil || message.object("request").text("method") != "page.get_storage" {
		t.Fatalf("metadata listing was not forwarded: %s %v", value(message), err)
	}
}

func TestIndexedDBCanariesStayOutOfDaemonSinks(t *testing.T) {
	d := sensitiveTestDaemon(t)
	extension, extensionReader := serviceWirePeer(t, d, "extension")
	agent, agentReader := serviceWirePeer(t, d, "agent")
	exchange := func(method string, params object, reply func(id string) object) object {
		t.Helper()
		if err := agent.send(object{"type": value("agent.request"), "request": value(newRequest(method, params, nil, 0))}); err != nil {
			t.Fatal(err)
		}
		message, err := readLine(extensionReader)
		if err != nil || message.object("request").text("method") != method {
			t.Fatalf("%s was not forwarded: %s %v", method, value(message), err)
		}
		if err := extension.send(object{"type": value("extension.response"), "response": value(reply(message.object("request").text("id")))}); err != nil {
			t.Fatal(err)
		}
		answer, err := readLine(agentReader)
		if err != nil {
			t.Fatal(err)
		}
		return answer.object("response")
	}
	record := json.RawMessage(`{"user":"` + sensitiveRecordCanary + `"}`)
	idb := exchange("sensitive.read", indexedDBReadParams(), func(id string) object { return success(id, indexedDBReadResult(record)) })
	if !jsonEqual(idb.object("result")["value"], record) {
		t.Fatalf("agent did not receive the exact record: %s", value(idb))
	}
	for _, response := range []object{idb} {
		if response.object("meta")["transport_bytes"] != nil {
			t.Fatal("daemon added size telemetry to a sensitive reply")
		}
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
	d.mu.Lock()
	sinks["daemon logs"] = value(d.logs).String()
	sinks["health diagnostics"] = value(d.health(nil, true)).String()
	sinks["recovery telemetry"] = value(d.telemetry.snapshot("daemon")).String()
	d.mu.Unlock()
	_ = filepath.WalkDir(d.config.home, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			if data, readErr := os.ReadFile(path); readErr == nil {
				sinks["file "+path] = string(data)
			}
		}
		return nil
	})
	for name, sink := range sinks {
		for _, secret := range []string{sensitiveRecordCanary, sensitiveDatabaseName, sensitiveStoreName} {
			if strings.Contains(sink, secret) {
				t.Fatalf("%s retained %s", name, secret)
			}
		}
	}
}

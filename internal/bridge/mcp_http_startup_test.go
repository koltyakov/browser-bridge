package bridge

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMCPHTTPDaemonStartupAndStdioFallback(t *testing.T) {
	for _, mode := range []string{"disabled", "enabled", "occupied", "invalid credential"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("BBX_AUTH_TOKEN", "")
			home := t.TempDir()
			reservation, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			address := reservation.Addr().String()
			_ = reservation.Close()
			c := config{home: home, network: "tcp", address: address, bind: address, agentToken: filepath.Join(home, "daemon.auth")}
			settings := mcpHTTPTestSettings(t)
			if mode == "occupied" {
				occupied, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = occupied.Close() }()
				settings.Listen = occupied.Addr().String()
			}
			if mode == "invalid credential" {
				settings.Clients["first"] = filepath.Join(home, "missing.token")
			}
			if mode != "disabled" {
				if err := writeCLIJSON(filepath.Join(home, "mcp-http.json"), settings); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			var runErr error
			go func() {
				defer close(done)
				runErr = runDaemon(ctx, c)
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
					if runErr != nil {
						t.Errorf("daemon failed: %v", runErr)
					}
				case <-time.After(5 * time.Second):
					t.Error("daemon did not stop")
				}
			})
			var native *client
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				native, err = connect(c, "agent")
				if err == nil {
					break
				}
				select {
				case <-done:
					t.Fatalf("daemon exited during startup: %v", runErr)
				case <-time.After(5 * time.Millisecond):
				}
			}
			if native == nil {
				t.Fatalf("native listener unavailable: %v", err)
			}
			defer native.close()
			callCtx, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			response, err := native.request(callCtx, newRequest("health.ping", object{}, nil, 0))
			if err != nil || !response.boolean("ok") {
				t.Fatalf("HTTP state broke native health: %s %v", value(response), err)
			}
			// Neither enabling HTTP nor a failed HTTP bind changes stdio dispatch.
			stdio := mcpTestStart(t, c)
			stdio.send(t, mcpTestRequest(1, "tools/list", nil, true))
			if !mcpTestToolNames(stdio.read(t).object("result"))["browser_skill"] {
				t.Fatal("stdio fallback unavailable")
			}
			path := filepath.Join(home, "mcp-http-status.json")
			if mode == "disabled" {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("default daemon created an HTTP endpoint registration")
				}
				return
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			status, err := decodeObject(data)
			if err != nil {
				t.Fatal(err)
			}
			if status.boolean("ready") != (mode == "enabled") {
				t.Fatalf("incorrect endpoint status: %s", data)
			}
			if strings.Contains(string(data), mcpHTTPTokenA) || strings.Contains(string(data), mcpHTTPTokenB) {
				t.Fatal("status leaked credentials")
			}
			if mode != "enabled" {
				if status.text("error") == "" {
					t.Fatal("HTTP startup failure was not reported")
				}
				return
			}
			request, err := http.NewRequest(http.MethodPost, status.text("url"), strings.NewReader(string(value(mcpTestCall(1, "browser_health", object{}, true)))))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+mcpHTTPTokenA)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Accept", "application/json, text/event-stream")
			request.Header.Set("MCP-Protocol-Version", modernVersion)
			request.Header.Set("Mcp-Method", "tools/call")
			request.Header.Set("Mcp-Name", "browser_health")
			result := mcpHTTPTestRead(t, mcpHTTPTestDo(t, request)).object("result")
			if result.boolean("isError") {
				t.Fatalf("daemon-hosted HTTP dispatch failed: %s", value(result))
			}
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("HTTP prevented daemon shutdown")
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatal("shutdown retained endpoint registration")
			}
			if conn, err := net.DialTimeout("tcp", strings.TrimSuffix(strings.TrimPrefix(status.text("url"), "http://"), "/mcp"), time.Second); err == nil {
				_ = conn.Close()
				t.Fatal("HTTP listener survived daemon shutdown")
			}
		})
	}
}

func TestMCPHTTPModernRejectsInvalidProtocolRequests(t *testing.T) {
	h := mcpHTTPTestStart(t, config{home: t.TempDir()})
	for _, message := range []object{
		mcpTestRequest(1, "not/a/method", nil, true),
		mcpTestRequest(1, "initialize", object{}, true),
		mcpTestCall(1, "not-a-tool", object{}, true),
		mcpTestCall(1, "browser_call", object{"method": value(12)}, true),
		mcpTestRequest(1, "subscriptions/listen", object{"notifications": value(object{"toolsListChanged": value("bad")})}, true),
	} {
		response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", message))
		if rejection := mcpHTTPTestRead(t, response); rejection["error"] == nil {
			t.Fatalf("invalid modern request was accepted: %s", value(message))
		}
	}
	message := mcpTestRequest(1, "ping", object{}, true)
	params := message.object("params")
	params["_meta"] = value(object{versionKey: value(modernVersion), capabilitiesKey: value[*int](nil)})
	message["params"] = value(params)
	if response := mcpHTTPTestDo(t, mcpHTTPTestRequest(t, h, mcpHTTPTokenA, "", message)); response.StatusCode != 400 {
		t.Fatal("null capabilities accepted")
	}
}

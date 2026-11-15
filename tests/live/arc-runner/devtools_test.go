package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

func TestArcConnectionRechecksIsolationBeforeAnyNetworkRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()
	sources := endpointFixture(t, "")
	endpointURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/devtools/browser/test"
	runner := arcRunner{sources: sources, selected: endpoint{endpointURL, "startup_log"}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := runner.connectEndpoint(ctx); err == nil {
		t.Fatal("connection accepted without an isolated port file")
	}
	if requests.Load() != 0 {
		t.Fatal("network connection happened before isolation verification")
	}
}

func TestArcConnectionSeparatesHTTPIdentityAndWebSocketReadiness(t *testing.T) {
	for _, mode := range []string{"success", "different-browser", "redirect", "websocket-failure"} {
		t.Run(mode, func(t *testing.T) {
			var websocketCalls atomic.Int32
			var redirectCalls atomic.Int32
			redirect := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
				redirectCalls.Add(1)
			}))
			defer redirect.Close()
			var endpointURL string
			mux := http.NewServeMux()
			mux.HandleFunc("/json/version", func(response http.ResponseWriter, request *http.Request) {
				if mode == "redirect" {
					http.Redirect(response, request, redirect.URL, http.StatusFound)
					return
				}
				value := endpointURL
				if mode == "different-browser" {
					value += "-different"
				}
				_ = json.NewEncoder(response).Encode(map[string]string{"webSocketDebuggerUrl": value})
			})
			mux.Handle("/devtools/browser/test", websocket.Handler(func(connection *websocket.Conn) {
				websocketCalls.Add(1)
				if mode == "websocket-failure" {
					return
				}
				var request struct {
					ID     int    `json:"id"`
					Method string `json:"method"`
				}
				if err := websocket.JSON.Receive(connection, &request); err != nil {
					return
				}
				if request.Method != "Browser.getVersion" {
					return
				}
				_ = websocket.JSON.Send(connection, struct {
					ID     int               `json:"id"`
					Result map[string]string `json:"result"`
				}{request.ID, map[string]string{"product": "Arc fixture"}})
			}))
			server := httptest.NewServer(mux)
			defer server.Close()
			endpointURL = "ws" + strings.TrimPrefix(server.URL, "http") + "/devtools/browser/test"
			sources := endpointFixture(t, "")
			u, err := url.Parse(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			writeTestFile(t, filepath.Join(sources.profiles[0], "DevToolsActivePort"), u.Port()+"\n/devtools/browser/test")
			runner := arcRunner{sources: sources, selected: endpoint{endpointURL, "startup_log"}}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result, err := runner.connectEndpoint(ctx)
			if runner.client != nil {
				defer func() { _ = runner.client.socket.Close() }()
			}
			if (err == nil) != (mode == "success") {
				t.Fatalf("result=%s err=%v", result, err)
			}
			if redirectCalls.Load() != 0 {
				t.Fatal("DevTools HTTP redirect escaped the selected endpoint")
			}
			if (mode == "different-browser" || mode == "redirect") && websocketCalls.Load() != 0 {
				t.Fatal("WebSocket opened despite a mismatched HTTP browser identity")
			}
		})
	}
}

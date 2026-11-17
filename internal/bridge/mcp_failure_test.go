package bridge

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func assertMCPUnconfirmedFailure(t *testing.T, result object, message string) {
	t.Helper()
	structured := result.object("structuredContent")
	recovery := structured.object("recovery")
	details := structured.object("error").object("details")
	if !result.boolean("isError") || structured.boolean("ok") || structured.object("error").text("code") != "INTERNAL_ERROR" || structured.object("error").text("message") != message {
		t.Fatalf("local failure lost its error: %s", value(result))
	}
	if string(recovery["retry"]) != "false" || recovery["retryAfterMs"] != nil || !strings.Contains(recovery.text("hint"), "do not replay") {
		t.Fatalf("unconfirmed result advertised a retry: %s", value(result))
	}
	if !details.boolean("outcomeUncertain") || details["completed"] != nil || details["dispatched"] != nil || details["aftermath"] != nil {
		t.Fatalf("local failure invented execution progress: %s", value(result))
	}
	if strings.Contains(string(value(result)), "Retry once") {
		t.Fatalf("unsafe generic guidance survived: %s", value(result))
	}
}

func TestMCPUnconfirmedErrorsDoNotAdvertiseRetry(t *testing.T) {
	for _, err := range []error{context.Canceled, context.DeadlineExceeded, io.EOF, net.ErrClosed, errors.New("local failure")} {
		t.Run(err.Error(), func(t *testing.T) {
			assertMCPUnconfirmedFailure(t, toolResult(nil, err), err.Error())
		})
	}
}

func TestMCPConfirmedResponsesKeepRecoveryAndProgress(t *testing.T) {
	for _, method := range []string{"input.perform", "page.get_state"} {
		response := failure("confirmed", "TIMEOUT", "A confirmed bridge failure.")
		if method == "input.perform" {
			err := response.object("error")
			err["details"] = value(object{"completed": value(1), "total": value(2)})
			response["error"] = value(err)
			protectResponseRecovery(response, method)
		}
		result := mcpResponse(response, method, nil)
		assertJSONEqual(t, value(toolResult(result, nil)), value(result))
		structured := result.object("structuredContent")
		if structured.object("recovery").boolean("retry") != (method == "page.get_state") {
			t.Fatalf("confirmed recovery changed: %s", value(result))
		}
		if method == "input.perform" && structured.object("error").object("details").number("completed") != 1 {
			t.Fatalf("confirmed partial progress lost: %s", value(result))
		}
	}
}

// EOF on MCP stdin can leave stdout writable long enough to deliver an error.
// Keep the streams independent to exercise that actual shutdown path.
func mcpTestEOFPeer(t *testing.T, c config) (*mcpTestPeer, *io.PipeWriter) {
	t.Helper()
	input, stdin := io.Pipe()
	server, stdout := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- mcpServe(ctx, c, input, server) }()
	t.Cleanup(func() {
		cancel()
		_ = stdin.Close()
		_ = input.Close()
		_ = stdout.Close()
		_ = server.Close()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("MCP server did not shut down")
		}
	})
	return &mcpTestPeer{conn: stdout, reader: bufio.NewReader(stdout), writer: &wireWriter{out: stdin}}, stdin
}

func TestMCPInterruptedSequenceDoesNotAdvertiseReplay(t *testing.T) {
	for _, modern := range []bool{false, true} {
		for _, fault := range []string{"cancel", "stdin_eof"} {
			era := map[bool]string{false: "legacy", true: "modern"}[modern]
			t.Run(era+"/"+fault, func(t *testing.T) {
				c, requests := mcpTestDaemon(t, func(request object) object {
					if request.text("method") == "input.perform" {
						// Dispatch has started, but no confirmed progress or
						// final result has reached this MCP connection.
						return nil
					}
					return success(request.text("id"), object{"daemon": value("ok")})
				})
				peer, stdin := mcpTestEOFPeer(t, c)
				if !modern {
					peer.send(t, mcpTestRequest(0, "initialize", object{"protocolVersion": value("2025-11-25")}, false))
					peer.read(t)
				}
				peer.send(t, mcpTestCall(1, "browser_call", object{
					"method": value("input.perform"), "tabId": value(23),
					"params": value(object{"steps": value([]object{
						{"method": value("input.click"), "params": value(object{"target": value(object{"selector": value("#first")})})},
						{"method": value("input.click"), "delayMs": value(2500), "params": value(object{"target": value(object{"selector": value("#late")})})},
					})}),
				}, modern))
				select {
				case request := <-requests:
					if request.text("method") != "input.perform" {
						t.Fatalf("unexpected request: %s", value(request))
					}
				case <-time.After(3 * time.Second):
					t.Fatal("sequence was not dispatched")
				}
				if fault == "cancel" {
					peer.send(t, object{"jsonrpc": value("2.0"), "method": value("notifications/cancelled"), "params": value(object{"requestId": value(1)})})
				} else if err := stdin.Close(); err != nil {
					t.Fatal(err)
				}
				message := peer.read(t)
				if message.number("id") != 1 {
					t.Fatalf("lost interrupted request ID: %s", value(message))
				}
				// EOF shutdown can surface cancellation or the closed daemon
				// connection. Both lack a confirmed execution result.
				result := message.object("result")
				assertMCPUnconfirmedFailure(t, result, result.object("structuredContent").object("error").text("message"))
				if fault == "cancel" {
					peer.send(t, mcpTestCall(2, "browser_health", object{}, modern))
					if !peer.read(t).object("result").object("structuredContent").boolean("ok") {
						t.Fatal("cancellation closed the shared connection")
					}
					select {
					case request := <-requests:
						if request.text("method") != "health.ping" {
							t.Fatalf("interrupted sequence was replayed: %s", value(request))
						}
					case <-time.After(3 * time.Second):
						t.Fatal("shared connection health check was not dispatched")
					}
				}
				select {
				case request := <-requests:
					t.Fatalf("interrupted sequence was replayed: %s", value(request))
				default:
				}
			})
		}
	}
}

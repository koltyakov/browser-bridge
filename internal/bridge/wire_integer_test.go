package bridge

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"testing"
	"time"
)

func FuzzObjectNumberMatchesIntegerSchema(f *testing.F) {
	for _, raw := range []string{"7", "7.0", "7e0", "0.7e1", "7.5", "null", "-0", "9007199254740991.0", "1e309"} {
		f.Add(raw)
	}
	schema := object{"type": value("integer")}
	f.Fuzz(func(t *testing.T, text string) {
		raw := json.RawMessage(text)
		if len(raw) > 128 || validateSchema(raw, schema, "number") != nil {
			return
		}
		var n json.Number
		if err := json.Unmarshal(raw, &n); err != nil {
			t.Fatal(err)
		}
		number, err := strconv.ParseFloat(string(n), 64)
		if err != nil {
			t.Fatal(err)
		}
		if got := (object{"number": raw}).number("number"); got != int64(number) {
			t.Fatalf("validated %s became %d, want %d", raw, got, int64(number))
		}
	})
}

func TestObjectNumberIntegralJSONSpellings(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int64
	}{
		{"7", 7},
		{"7.0", 7},
		{"7e0", 7},
		{"7E+0", 7},
		{"0.7e1", 7},
		{"700e-2", 7},
		{"-7.0", -7},
		{"-7e0", -7},
		{"0.0", 0},
		{"-0e0", 0},
		{" 7.0 \n", 7},
		{"9007199254740991.0", 9_007_199_254_740_991},
		{"9.007199254740991e15", 9_007_199_254_740_991},
		{"-9.007199254740991e15", -9_007_199_254_740_991},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			raw := json.RawMessage(tc.raw)
			if err := validateSchema(raw, object{"type": value("integer")}, "number"); err != nil {
				t.Fatalf("schema rejected integral spelling: %v", err)
			}
			if got := (object{"number": raw}).number("number"); got != tc.want {
				t.Fatalf("number(%s) = %d, want %d", raw, got, tc.want)
			}
		})
	}
}

func TestObjectNumberRejectsInvalidFallbackValues(t *testing.T) {
	for _, raw := range []string{
		"", "null", "true", `"7"`, "[]", "{}", "invalid", "NaN", "Infinity",
		"01", "+7", "7.", "7e", "7 8", "7.5", "7e-1", "-7.5",
		"9007199254740992.0", "-9007199254740992e0", "1e19", "1e309",
		"9223372036854775808", "-9223372036854775809",
	} {
		t.Run(raw, func(t *testing.T) {
			if got := (object{"number": json.RawMessage(raw)}).number("number"); got != 0 {
				t.Fatalf("invalid number(%q) = %d, want 0", raw, got)
			}
		})
	}
	if got := (object{}).number("missing"); got != 0 {
		t.Fatalf("missing number = %d, want 0", got)
	}
}

func TestObjectNumberPreservesExactNativeIntegerLiterals(t *testing.T) {
	for _, want := range []int64{math.MinInt64, math.MaxInt64, 9_007_199_254_740_992} {
		if got := (object{"number": value(want)}).number("number"); got != want {
			t.Fatalf("native integer = %d, want %d", got, want)
		}
	}
}

func TestIntegralJSONTabIDMCPForwarding(t *testing.T) {
	for _, spelling := range []string{"7.0", "7e0"} {
		t.Run(spelling, func(t *testing.T) {
			c, requests := mcpTestDaemon(t, func(request object) object {
				return success(request.text("id"), object{})
			})
			s := &mcpSession{config: c, agentSession: "integral-tab-test"}
			t.Cleanup(func() {
				for _, cl := range s.clients {
					cl.close()
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			result, err := s.handleTool(ctx, "browser_page", object{
				"action": value("state"), "tabId": json.RawMessage(spelling), "extensionId": value("profile-a"),
			}, "modern")
			if err != nil || result.boolean("isError") {
				t.Fatalf("MCP call failed: %v %s", err, value(result))
			}
			select {
			case request := <-requests:
				if string(request["tab_id"]) != "7" || request.object("meta").text("target_extension") != "profile-a" {
					t.Fatalf("MCP lost explicit tab routing: %s", value(request))
				}
			case <-ctx.Done():
				t.Fatal("MCP did not forward the request")
			}
		})
	}
}

func TestIntegralJSONTabIDDaemonForwarding(t *testing.T) {
	for _, spelling := range []string{"7.0", "7e0"} {
		t.Run(spelling, func(t *testing.T) {
			d := serviceTestDaemon(t)
			agent := serviceTestPeer(t, d, "agent")
			extension := serviceTestPeer(t, d, "extension")
			request := newRequest("page.get_state", nil, object{"target_extension": value(extension.id)}, 0)
			request["tab_id"] = json.RawMessage(spelling)
			d.route(agent, request)
			forwarded := serviceNextMessage(t, extension).object("request")
			if string(forwarded["tab_id"]) != spelling {
				t.Fatalf("daemon changed tab spelling: %s", value(forwarded))
			}
			pending := d.pending[forwarded.text("id")]
			if pending == nil || pending.requestedTab != 7 {
				t.Fatal("daemon did not retain the explicit tab for scheduling")
			}
		})
	}
}

func TestIntegralJSONTabIDDaemonRejectsInvalidValues(t *testing.T) {
	for _, spelling := range []string{
		`"7"`, "true", "{}", "0", "-7.0", "7.5", "7e-1",
		"9007199254740992", "9007199254740992.0", "1e19", "9223372036854775808",
	} {
		t.Run(spelling, func(t *testing.T) {
			d := serviceTestDaemon(t)
			agent := serviceTestPeer(t, d, "agent")
			extension := serviceTestPeer(t, d, "extension")
			request := newRequest("page.get_state", nil, nil, 0)
			request["tab_id"] = json.RawMessage(spelling)
			d.route(agent, request)
			response := serviceNextMessage(t, agent).object("response")
			if response.object("error").text("code") != "INVALID_REQUEST" || len(extension.out) != 0 || len(d.pending) != 0 {
				t.Fatalf("invalid tab was not rejected before forwarding: %s", value(response))
			}
		})
	}
}

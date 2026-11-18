package bridge

import (
	"context"
	"testing"
)

func TestMalformedMethodParamsFailBeforeMCPDispatch(t *testing.T) {
	cases := []struct {
		method string
		params object
	}{
		{"dom.query", object{"selector": value([]string{})}},
		{"dom.query", object{"maxNodes": value("5")}},
		{"dom.query", object{"maxDepth": value(object{})}},
		{"dom.query", object{"includeBbox": value("yes")}},
		{"page.get_text", object{"textBudget": value("80")}},
		{"dom.get_text", object{"target": value([]string{})}},
		{"dom.find_by_role", object{"role": value(42)}},
		{"dom.find_by_role", object{"role": value("button"), "includeHidden": value([]string{})}},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+string(value(tc.params)), func(t *testing.T) {
			if err := validateMethodParams(tc.method, tc.params); err == nil {
				t.Fatal("malformed canonical parameter accepted")
			}
			for _, tool := range []string{"browser_call", "browser_dom"} {
				session := &mcpSession{}
				args := object{"method": value(tc.method), "params": value(tc.params)}
				if tool == "browser_dom" {
					// Typed tools are validated separately; exercise the query
					// fallback that previously replaced malformed selectors.
					if tc.method != "dom.query" {
						continue
					}
					args = mcpClone(tc.params)
					args["action"] = value("query")
				}
				result, err := session.handleTool(context.Background(), tool, args, "modern")
				if err != nil || !result.boolean("isError") || result.object("structuredContent").object("error").text("code") != "INVALID_REQUEST" {
					t.Fatalf("%s did not reject locally: %s %v", tool, value(result), err)
				}
			}
			d := serviceTestDaemon(t)
			peer := &peer{out: make(chan queuedMessage, 1), done: make(chan struct{}), role: "agent"}
			d.route(peer, newRequest(tc.method, tc.params, nil, 1))
			response := serviceNextMessage(t, peer).object("response")
			if response.object("error").text("code") != "INVALID_REQUEST" || len(d.pending) != 0 {
				t.Fatalf("daemon did not reject before routing: %s", value(response))
			}
		})
	}
}

func TestMethodParamValidationPreservesNumericClampingAndAliases(t *testing.T) {
	for _, params := range []object{
		{},
		{"selector": value(""), "maxNodes": value(0), "maxDepth": value(100), "textBudget": value(1)},
		{"withinRef": value[*string](nil), "attributeAllowlist": value([]string{})},
		{"budget": value(object{"maxNodes": value(5)})},
	} {
		if err := validateMethodParams("dom.query", params); err != nil {
			t.Fatalf("compatible input rejected: %s %v", value(params), err)
		}
	}
}

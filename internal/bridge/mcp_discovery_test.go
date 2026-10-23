package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestMethodDiscoveryIncludesOnDemandSchemasAndExamples(t *testing.T) {
	for method := range catalog.MethodInputs {
		detail := describe(object{"method": value(method)})
		mcp := mcpDescribe(object{"method": value(method)}).object("structuredContent")
		for _, result := range []object{detail, mcp} {
			schema := result.object("inputSchema")
			if schema.text("type") != "object" || result.object("example") == nil {
				t.Fatalf("%s missing actionable discovery: %s", method, value(result))
			}
			if err := validateSchema(result["example"], schema, method); err != nil {
				t.Fatalf("%s example does not match its schema: %v", method, err)
			}
			if !jsonEqual(detail["inputSchema"], mcp["inputSchema"]) {
				t.Fatalf("CLI and MCP schemas differ for %s", method)
			}
		}
	}
	click := describe(object{"method": value("input.click")}).object("inputSchema")
	if click.object("properties").object("target").object("properties").object("role").text("type") != "string" {
		t.Fatal("nested locator schema is missing")
	}
	if err := validateSchema(value(object{}), click, "click"); err == nil {
		t.Fatal("missing click target accepted")
	}
	for _, group := range []object{describe(object{"group": value("interact")}), mcpDescribe(object{"group": value("interact")}).object("structuredContent")} {
		var methods []object
		_ = json.Unmarshal(group["methods"], &methods)
		for _, method := range methods {
			if method["inputSchema"] != nil || method["example"] != nil {
				t.Fatal("broad group discovery includes expensive details")
			}
		}
	}
}

func TestMCPProfileDiscoveryIsBoundedConcurrentAndOrdered(t *testing.T) {
	started := make(chan string, 7)
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	profiles := []object{}
	for i := 0; i < 7; i++ {
		profiles = append(profiles, object{"extensionId": value(fmt.Sprintf("profile-%d", i)), "accessEnabled": value(true)})
	}
	profiles = append(profiles, object{"extensionId": value("disabled"), "accessEnabled": value(false)})
	c, _ := mcpTestDaemon(t, func(request object) object {
		if request.text("method") == "health.ping" {
			return success("", object{"connectedExtensions": value(profiles)})
		}
		profile := request.object("meta").text("target_extension")
		started <- profile
		<-release
		if profile == "profile-2" {
			return failure("", "ACCESS_DENIED", "profile unavailable")
		}
		return success("", object{"tabs": value([]object{{"tabId": value(12), "title": value(profile)}})})
	})
	s := &mcpSession{config: c}
	defer func() {
		if s.client != nil {
			s.client.close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	type outcome struct {
		response object
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		response, err := s.profileTabs(ctx, object{}, object{}, "modern")
		done <- outcome{response, err}
	}()
	for i := 0; i < 5; i++ {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("profile requests ran serially")
		}
	}
	select {
	case profile := <-started:
		t.Fatalf("concurrency exceeded five: %s", profile)
	default:
	}
	close(release)
	result := <-done
	if result.err != nil || !result.response.boolean("ok") {
		t.Fatalf("discovery failed: %v %s", result.err, value(result.response))
	}
	r := result.response.object("result")
	var tabs, records []object
	_ = json.Unmarshal(r["tabs"], &tabs)
	_ = json.Unmarshal(r["profiles"], &records)
	if !r.boolean("partial") || len(tabs) != 6 || len(records) != 7 {
		t.Fatalf("partial discovery lost results: %s", value(r))
	}
	for i, record := range records {
		if record.text("extensionId") != fmt.Sprintf("profile-%d", i) || record.boolean("ok") == (i == 2) {
			t.Fatalf("profile order or outcome changed: %s", value(records))
		}
	}
	for i, tab := range tabs {
		index := i
		if i >= 2 {
			index++
		}
		if tab.text("extensionId") != fmt.Sprintf("profile-%d", index) || tab.text("title") != tab.text("extensionId") {
			t.Fatalf("tab routing/order changed: %s", value(tabs))
		}
	}
}

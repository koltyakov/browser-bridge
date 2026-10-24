package bridge

import (
	"context"
	"errors"
	"testing"
)

func assertElementRefQuery(t *testing.T, params object) {
	t.Helper()
	assertJSONEqual(t, value(params), []byte(`{"selector":"#target","maxNodes":1,"maxDepth":1,"textBudget":32,"includeBbox":false,"attributeAllowlist":[]}`))
}

func TestMCPSelectorLookupOnlyCollectsOneRef(t *testing.T) {
	fixtures := []struct {
		tool, action, method string
		args                 object
	}{
		{"browser_dom", "describe", "dom.describe", nil},
		{"browser_dom", "text", "dom.get_text", object{"textBudget": value(200)}},
		{"browser_dom", "attributes", "dom.get_attributes", object{"attributes": value([]string{"id"})}},
		{"browser_dom", "html", "dom.get_html", object{"maxLength": value(100)}},
		{"browser_styles_layout", "computed", "styles.get_computed", object{"properties": value([]string{"color"})}},
		{"browser_styles_layout", "matched_rules", "styles.get_matched_rules", nil},
		{"browser_styles_layout", "box_model", "layout.get_box_model", nil},
		{"browser_patch", "apply_styles", "patch.apply_styles", object{"declarations": value(object{"color": value("red")})}},
		{"browser_patch", "apply_dom", "patch.apply_dom", object{"operation": value("set_text"), "value": value("Updated")}},
		{"browser_capture", "element", "screenshot.capture_element", nil},
	}
	for _, fixture := range fixtures {
		for _, explicitRef := range []bool{false, true} {
			t.Run(fixture.method+map[bool]string{false: "/selector", true: "/ref"}[explicitRef], func(t *testing.T) {
				c, requests := mcpTestDaemon(t, func(request object) object {
					if request.text("method") == "screenshot.capture_element" {
						return success(request.text("id"), object{"image": value("data:image/png;base64,aGVsbG8="), "complete": value(true)})
					}
					return success(request.text("id"), object{"nodes": value([]object{{"elementRef": value("el_test_1")}})})
				})
				s := &mcpSession{config: c, agentSession: "selector-test"}
				t.Cleanup(func() {
					for _, cl := range s.clients {
						cl.close()
					}
				})
				args := mcpClone(fixture.args)
				args["action"], args["selector"], args["tabId"], args["extensionId"] = value(fixture.action), value("#target"), value(7), value("profile-a")
				if explicitRef {
					args["elementRef"] = value("el_test_1")
				}
				result, err := s.handleTool(context.Background(), fixture.tool, args, "legacy")
				if err != nil || result.boolean("isError") {
					t.Fatalf("selector call failed: %v %s", err, value(result))
				}
				if !explicitRef {
					query := <-requests
					if query.text("method") != "dom.query" {
						t.Fatalf("missing selector lookup: %s", value(query))
					}
					assertElementRefQuery(t, query.object("params"))
					if query.number("tab_id") != 7 || query.object("meta").text("target_extension") != "profile-a" {
						t.Fatalf("lookup lost routing: %s", value(query))
					}
				}
				request := <-requests
				if request.text("method") != fixture.method || request.number("tab_id") != 7 || request.object("meta").text("target_extension") != "profile-a" {
					t.Fatalf("wrong follow-up request: %s", value(request))
				}
				params := request.object("params")
				ref := params.text("elementRef")
				if fixture.tool == "browser_patch" {
					ref = params.object("target").text("elementRef")
				}
				if ref != "el_test_1" || len(requests) != 0 {
					t.Fatalf("lookup did not reuse the ref: %s", value(request))
				}
				for key, expected := range fixture.args {
					if !jsonEqual(params[key], expected) {
						t.Fatalf("lookup changed %s: %s", key, value(params))
					}
				}
			})
		}
	}
}

func TestCLIScreenshotSelectorLookupOnlyCollectsOneRef(t *testing.T) {
	for _, target := range []string{"#target", "el_test_1"} {
		t.Run(target, func(t *testing.T) {
			stop := errors.New("capture sentinel")
			queries, captures := 0, 0
			call := func(_ context.Context, method string, params object) (object, error) {
				switch method {
				case "dom.query":
					queries++
					assertElementRefQuery(t, params)
					return object{"nodes": value([]object{{"elementRef": value("el_test_1")}})}, nil
				case "screenshot.capture_element":
					captures++
					if params.text("elementRef") != "el_test_1" || params.text("delivery") != "artifact" {
						t.Fatalf("wrong capture params: %s", value(params))
					}
					return nil, stop
				default:
					t.Fatalf("unexpected method %s", method)
					return nil, stop
				}
			}
			if err := screenshotCLI(context.Background(), call, []string{target}); !errors.Is(err, stop) {
				t.Fatal(err)
			}
			wantQueries := 0
			if target == "#target" {
				wantQueries = 1
			}
			if queries != wantQueries || captures != 1 {
				t.Fatalf("got %d queries and %d captures", queries, captures)
			}
		})
	}
}

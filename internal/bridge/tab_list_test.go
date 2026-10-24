package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func testTabList(count int) []object {
	tabs := make([]object, count)
	for i := range tabs {
		tabs[i] = object{"tabId": value(i + 1), "title": value(fmt.Sprintf("Tab %d", i+1)), "url": value(fmt.Sprintf("https://example.com/runs/%d", i+1))}
	}
	return tabs
}

func TestTabListOffsetDefault(t *testing.T) {
	tabs := testTabList(147)
	for _, tc := range []struct {
		name   string
		params object
		count  int
		next   int64
	}{
		{"default", object{}, 30, 30},
		{"offset-only", object{"offset": value(10)}, 30, 40},
		{"explicit-limit", object{"limit": value(5), "offset": value(10)}, 5, 15},
	} {
		t.Run(tc.name, func(t *testing.T) {
			page := mcpTabPage(tabs, tc.params)
			var listed []object
			if err := json.Unmarshal(page["tabs"], &listed); err != nil {
				t.Fatal(err)
			}
			if len(listed) != tc.count {
				t.Fatalf("got %d tabs, want %d", len(listed), tc.count)
			}
			if tc.next != 0 && page.object("pagination").number("nextOffset") != tc.next {
				t.Fatalf("unexpected pagination: %s", page["pagination"])
			}
		})
	}
}

func TestTabListSummaryDefault(t *testing.T) {
	for _, total := range []int{47, 147} {
		t.Run(fmt.Sprint(total), func(t *testing.T) {
			summary := cliSummaryNow(success("tabs", object{"tabs": value(testTabList(total))}), "tabs.list")
			var listed []object
			if err := json.Unmarshal(summary["evidence"], &listed); err != nil {
				t.Fatal(err)
			}
			if len(listed) != min(total, 30) {
				t.Fatalf("got %d tabs, want %d", len(listed), min(total, 30))
			}
			if summary.object("pagination").number("omittedCount") != int64(max(0, total-30)) {
				t.Fatalf("unexpected pagination: %s", summary["pagination"])
			}
		})
	}
}

func TestMCPTabListPaginatesToTargetURL(t *testing.T) {
	tabs := testTabList(47)
	const targetURL = "https://github.com/wmgtech/wmg2-dsc/actions/runs/39978973050"
	tabs[46]["url"] = value(targetURL)
	result := mcpResponse(success("tabs", object{"tabs": value(tabs)}), "tabs.list", object{}).object("structuredContent")
	var listed []object
	if err := json.Unmarshal(result.object("evidence")["tabs"], &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 30 || result.object("pagination").number("totalCount") != 47 || result.object("pagination").number("nextOffset") != 30 {
		t.Fatalf("unexpected first page: %s", value(result))
	}
	params := object{"offset": result.object("pagination")["nextOffset"]}
	page := mcpTabPage(tabs, params)
	result = mcpResponse(success("tabs", page), "tabs.list", params).object("structuredContent")
	if err := json.Unmarshal(result.object("evidence")["tabs"], &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 17 || listed[16].text("url") != targetURL || string(result.object("pagination")["nextOffset"]) != "null" {
		t.Fatalf("unexpected final page: %s", value(result))
	}
}

func TestMCPDiscoveryPaginationAcrossProfiles(t *testing.T) {
	for _, tool := range []string{"browser_call", "browser_tabs", "browser_batch"} {
		t.Run(tool, func(t *testing.T) {
			c, _ := mcpTestDaemon(t, func(request object) object {
				if request.text("method") == "health.ping" {
					return success("", object{"connectedExtensions": value([]object{
						{"extensionId": value("profile-a"), "accessEnabled": value(true)},
						{"extensionId": value("profile-b"), "accessEnabled": value(true)},
					})})
				}
				return success("", object{"tabs": value(testTabList(40))})
			})
			s := &mcpSession{config: c}
			t.Cleanup(func() {
				for _, client := range s.clients {
					client.close()
				}
			})
			params := object{}
			total := 0
			for page := 0; page < 3; page++ {
				args := object{"method": value("tabs.list"), "params": value(params)}
				switch tool {
				case "browser_tabs":
					args = mcpClone(params)
					args["action"] = value("list")
				case "browser_batch":
					args = object{"calls": value([]object{args})}
				}
				response, err := s.handleTool(context.Background(), tool, args, "modern")
				if err != nil || response.boolean("isError") {
					t.Fatalf("listing failed: %v %s", err, value(response))
				}
				result := response.object("structuredContent")
				if tool == "browser_batch" {
					var results []object
					if err := json.Unmarshal(result["results"], &results); err != nil || len(results) != 1 {
						t.Fatalf("invalid batch results: %v %s", err, value(result))
					}
					result = results[0]
				}
				var tabs []object
				if err := json.Unmarshal(result.object("evidence")["tabs"], &tabs); err != nil {
					t.Fatal(err)
				}
				if len(tabs) != min(30, 80-total) || result.object("pagination").number("totalCount") != 80 {
					t.Fatalf("unexpected page: %s", value(result))
				}
				for _, tab := range tabs {
					if tab.text("extensionId") == "" {
						t.Fatal("tab routing identity missing")
					}
				}
				total += len(tabs)
				params["offset"] = result.object("pagination")["nextOffset"]
			}
			if total != 80 || string(params["offset"]) != "null" {
				t.Fatalf("pagination did not finish: total=%d offset=%s", total, params["offset"])
			}
		})
	}
}

func TestMCPErrorDetailsAreNotRepeatedAsEvidence(t *testing.T) {
	c, _ := mcpTestDaemon(t, func(request object) object {
		response := failure("", "TAB_MISMATCH", "Multiple browser profiles match.")
		err := response.object("error")
		err["details"] = value(object{"reason": value("ambiguous_browser_target")})
		response["error"] = value(err)
		return response
	})
	s := &mcpSession{config: c}
	t.Cleanup(func() {
		for _, client := range s.clients {
			client.close()
		}
	})
	call := object{"method": value("page.get_state"), "tabId": value(4)}
	for tool, args := range map[string]object{
		"browser_call":  call,
		"browser_batch": {"calls": value([]object{call})},
	} {
		response, err := s.handleTool(context.Background(), tool, args, "modern")
		if err != nil {
			t.Fatal(err)
		}
		result := response.object("structuredContent")
		if tool == "browser_batch" {
			var results []object
			if err := json.Unmarshal(result["results"], &results); err != nil || len(results) != 1 {
				t.Fatalf("invalid batch results: %v %s", err, value(result))
			}
			result = results[0]
		}
		if string(result["evidence"]) != "null" || result.object("error").object("details").text("reason") != "ambiguous_browser_target" {
			t.Errorf("%s: details should appear once, under error: %s", tool, value(result))
		}
	}
}

package bridge

import (
	"strings"
	"testing"
)

// Exercise batch formatters directly without authorizing mutation batching.
func aftermathFormats(response object, method string) []object {
	return []object{
		cliSummaryNow(response, method),
		cliBatchResult(method, 9, response, nil, 2, 1700000000000),
		mcpResponse(response, method, nil).object("structuredContent"),
		mcpBatchResult(response, method, nil, nil, 2),
	}
}

func TestInputAftermathSurvivesFormatters(t *testing.T) {
	for _, status := range []string{"not_requested", "completed", "failed", "unavailable", "interrupted"} {
		t.Run(status, func(t *testing.T) {
			observation := object{"status": value(status)}
			if status == "interrupted" {
				observation["interruption"] = value(object{"code": value("DIALOG_BLOCKED"), "dialogId": value("dialog_1")})
			}
			aftermath := object{
				"dispatch": value("completed"), "observation": value(observation),
				"verification": value("not_requested"),
			}
			effects := object{"dom": value(object{"added": value(1), "removed": value(0)}), "changed": value(true)}
			result := object{"elementRef": value("el_1"), "clicked": value(true), "effects": value(effects), "aftermath": value(aftermath)}
			for _, formatted := range aftermathFormats(success("click", result), "input.click") {
				if !formatted.boolean("ok") {
					t.Fatalf("acknowledged input failed: %s", value(formatted))
				}
				evidence := formatted.object("evidence")
				assertJSONEqual(t, evidence["aftermath"], value(aftermath))
				assertJSONEqual(t, evidence["effects"], value(effects))
				if evidence["verified"] != nil {
					t.Fatalf("effects promoted to verification: %s", value(evidence))
				}
				wantWarning := status == "failed" || status == "unavailable" || status == "interrupted"
				if strings.Contains(formatted.text("summary"), "application outcome unverified") != wantWarning {
					t.Fatalf("unexpected observation summary: %s", formatted.text("summary"))
				}
			}
		})
	}
}

func TestUncertainInputFailureSurvivesFormatters(t *testing.T) {
	details := compactionFixture(t, `{"aftermath":{"dispatch":"uncertain","observation":{"status":"interrupted","reason":"action_interrupted"},"verification":"not_requested"},"outcomeUncertain":true}`)
	recovery := object{"retry": value(false), "hint": value("Inspect postconditions; do not replay automatically.")}
	response := failure("click", "TIMEOUT", "Input dispatch was interrupted.")
	err := response.object("error")
	err["details"], err["recovery"] = value(details), value(recovery)
	response["error"] = value(err)
	for _, formatted := range aftermathFormats(response, "input.click") {
		if formatted.boolean("ok") || formatted.object("recovery").boolean("retry") {
			t.Fatalf("uncertain input became retryable: %s", value(formatted))
		}
		assertJSONEqual(t, formatted["recovery"], value(recovery))
		// CLI uses evidence; MCP deduplicates failure evidence under error.details.
		evidence := formatted["evidence"]
		if !cliPresent(evidence) {
			evidence = formatted.object("error")["details"]
		}
		assertJSONEqual(t, evidence, value(details))
	}
}

func TestSequenceVerificationRemainsExplicitInFormatters(t *testing.T) {
	last := compactionFixture(t, `{"index":0,"method":"input.click","result":{"clicked":true,"aftermath":{"dispatch":"completed","observation":{"status":"failed","reason":"finish_failed"},"verification":"not_requested"}}}`)
	for _, verified := range []bool{false, true} {
		result := object{"performed": value(true), "completed": value(1), "total": value(1), "elapsedMs": value(5), "lastResult": value(last)}
		if verified {
			result["verified"] = value(true)
			result["outcomes"] = value([]object{{"kind": value("dom"), "status": value("matched")}})
		}
		for _, formatted := range aftermathFormats(success("sequence", result), "input.perform") {
			evidence := formatted.object("evidence")
			assertJSONEqual(t, evidence["lastResult"], value(last))
			if verified {
				assertJSONEqual(t, evidence["verified"], value(true))
				assertJSONEqual(t, evidence["outcomes"], result["outcomes"])
				if !strings.Contains(formatted.text("summary"), "verified 1 outcome") {
					t.Fatalf("explicit verification lost: %s", value(formatted))
				}
			} else if evidence["verified"] != nil {
				t.Fatalf("sequence verification invented: %s", value(formatted))
			}
		}
	}
}

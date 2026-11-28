package bridge

import (
	"context"
	"slices"
	"strings"
	"testing"
)

func TestHoistLeadingRoutingFlagsMovesFlagsAfterTheCommand(t *testing.T) {
	got := hoistLeadingRoutingFlags([]string{"--tab", "7", "--evidence-only", "call", "page.get_state", "{}"})
	if !slices.Equal(got, []string{"call", "--tab", "7", "--evidence-only", "page.get_state", "{}"}) {
		t.Fatalf("hoisted: %q", got)
	}
	if got := hoistLeadingRoutingFlags([]string{"call", "--tab", "7", "page.get_state"}); got[0] != "call" {
		t.Fatalf("unchanged args moved: %q", got)
	}
	request, err := parseCLI(hoistLeadingRoutingFlags([]string{"--tab", "7", "call", "page.get_state", "{}"}))
	if err != nil || request.number("tab_id") != 7 {
		t.Fatalf("parsed: %s %v", value(request), err)
	}
}

func TestFileCommandAcceptsLeadingRoutingFlags(t *testing.T) {
	cliUpdateTestHome(t)
	t.Setenv("BBX_AUTO_UPDATE", "off")
	for _, args := range [][]string{
		{"--tab", "7", "--profile", "work", "record", "{}", "out.txt"},
		{"record", "--tab", "7", "--profile", "work", "{}", "out.txt"},
	} {
		// record only checks the output extension after it has a tab and both positional arguments.
		if err := run(context.Background(), args); err == nil || err.Error() != "recording output must be .json, .html, or .mp4" {
			t.Fatalf("file command did not receive its routing and positional arguments: %v: %v", args, err)
		}
	}
}

func TestFileCommandRejectsUnsupportedOutputFlags(t *testing.T) {
	cliUpdateTestHome(t)
	t.Setenv("BBX_AUTO_UPDATE", "off")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--evidence-only", "upload", "--tab", "7", "#file", "a.png"}, "--evidence-only is not supported by bbx upload"},
		{[]string{"--preset", "quick", "record", "--tab", "7", "{}", "out.json"}, "--preset is not supported by bbx record"},
		{[]string{"--tab", "7", "--preset", "quick", "download", "https://example.test/a", "a.bin"}, "--preset is not supported by bbx download"},
		{[]string{"screenshot", "--evidence-only", "--tab", "7"}, "--evidence-only is not supported by bbx screenshot"},
	} {
		// The flag must fail before it is read as a target, path, or capture option.
		if err := run(context.Background(), tc.args); err == nil || err.Error() != tc.want {
			t.Errorf("%v: got %v, want %q", tc.args, err, tc.want)
		}
	}
}

func TestFoldCLIRoutingParamsMovesRoutingOutOfParams(t *testing.T) {
	request, err := parseCLI([]string{"call", "input.perform", `{"tabId":7,"extensionId":"ext-1","steps":[{"method":"input.click","params":{"target":{"selector":"#a"}}}]}`})
	if err != nil {
		t.Fatal(err)
	}
	folded, err := foldCLIRoutingParams(request)
	if err != nil {
		t.Fatal(err)
	}
	params := folded.object("params")
	if folded.number("tab_id") != 7 || folded.object("meta").text("target_extension") != "ext-1" || params["tabId"] != nil || params["extensionId"] != nil || params["steps"] == nil {
		t.Fatalf("folded: %s", value(folded))
	}
	conflict, err := parseCLI([]string{"call", "--tab", "8", "page.get_state", `{"tabId":7}`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := foldCLIRoutingParams(conflict); err == nil || !strings.Contains(err.Error(), "conflicts with --tab") {
		t.Fatalf("conflict accepted: %v", err)
	}
	remote, err := parseCLI([]string{"call", "page.get_state", `{"destinationId":"vm"}`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := foldCLIRoutingParams(remote); err == nil || !strings.Contains(err.Error(), "--remote") {
		t.Fatalf("destination folded silently: %v", err)
	}
}

func TestUnknownCommandMessageSuggestsInsteadOfDumpingUsage(t *testing.T) {
	for command, want := range map[string]string{
		"--tab":         "Put flags after the command",
		"dom-qurey":     "Did you mean `bbx dom-query`?",
		"page.navigate": "Did you mean `bbx call navigation.navigate`?",
		"frobnicate":    "bbx call <method>",
	} {
		if got := unknownCommandMessage(command); !strings.Contains(got, want) {
			t.Errorf("%s: %s", command, got)
		}
	}
}

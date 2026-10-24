package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These fixed expectations were captured from the retired JavaScript runtime.
// Only release version strings are substituted; behavior stays fixture-defined.
func readContractFixture(t *testing.T, name string) json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "legacy-contracts", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return []byte(strings.NewReplacer(
		"$PROTOCOL_VERSION", protocolVersion(),
		"$COMPATIBLE_MINOR_VERSION", strings.Split(protocolVersion(), ".")[0]+".999",
		"$SERVER_VERSION", version,
	).Replace(string(data)))
}

func readContractCase(t *testing.T, name, key string) json.RawMessage {
	t.Helper()
	var fixtures object
	if err := json.Unmarshal(readContractFixture(t, name), &fixtures); err != nil {
		t.Fatal(err)
	}
	fixture, ok := fixtures[strings.ReplaceAll(key, " ", "_")]
	if !ok {
		t.Fatalf("missing %s contract fixture %q", name, key)
	}
	return fixture
}

func TestCLIFormatterContracts(t *testing.T) {
	var fixtures []object
	if err := json.Unmarshal(readContractFixture(t, "cli-formatters"), &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != 141 {
		t.Fatalf("formatter contract cases: got %d, want 141", len(fixtures))
	}
	for _, fixture := range fixtures {
		t.Run(fixture.text("name"), func(t *testing.T) {
			response := fixture.object("response")
			method := fixture.text("method")
			summary := cliSummarize(response, method, 1700000000000)
			assertJSONEqual(t, value(summary), fixture["summary"])
			annotated := cliAnnotate(summary, response)
			assertJSONEqual(t, value(annotated), fixture["annotated"])
			assertJSONEqual(t, cliJSON(value(annotated), true), fixture["sanitized"])
			if method == "" {
				method = "page.get_state"
			}
			batch := cliBatchResult(method, 9, response, nil, 12, 1700000000000)
			assertJSONEqual(t, value(batch), fixture["batch"])
		})
	}
}

func TestCLIBatchValidationContracts(t *testing.T) {
	fixtures := []string{`[{"method":"page.get_state"},{"method":"input.click","params":{}}]`, `[null,5,[],{}]`, `[{"method":"no.method"}]`, `[{"method":"sensitive.read"}]`, `[{"method":"page.get_state","params":null}]`, `[{"method":"page.get_state","extensionId":""}]`, `[{"method":"page.get_console","params":{"clear":true}}]`}
	for _, raw := range fixtures {
		t.Run(raw, func(t *testing.T) {
			_, invalid, err := prepareCLIBatch([]byte(raw), "")
			if err != nil {
				t.Fatal(err)
			}
			assertJSONEqual(t, value(invalid), readContractCase(t, "cli-batch-validation", raw))
		})
	}
}

func TestCLIBatchThrownErrorContract(t *testing.T) {
	got := cliBatchResult("page.get_state", 0, nil, errors.New("Connection lost"), 12, 1700000000000)
	assertJSONEqual(t, value(got), readContractFixture(t, "cli-batch-error"))
}

func TestCLIReportedErrorsAreNotDuplicated(t *testing.T) {
	var stdout, stderr bytes.Buffer
	reportCLIError([]string{"click", "main"}, errors.New("bad input"), &stdout, &stderr)
	assertJSONEqual(t, stdout.Bytes(), []byte(`{"ok":false,"summary":"ERROR: bad input","evidence":null}`))
	if stderr.Len() != 0 {
		t.Fatal(stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	reportCLIError([]string{"call", "page.get_state"}, cliPrintedError{}, &stdout, &stderr)
	if stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatal("printed response emitted twice")
	}
	reportCLIError([]string{"config", "get", "wrong"}, errors.New("Usage: config"), &stdout, &stderr)
	if stdout.Len() != 0 || stderr.String() != "Usage: config\n" {
		t.Fatal(stdout.String(), stderr.String())
	}
	payload := cliErrorPayload(context.DeadlineExceeded)
	if !strings.HasPrefix(payload.text("summary"), "BRIDGE_TIMEOUT:") {
		t.Fatal(payload)
	}
}

func TestCLIPrinterChannelContracts(t *testing.T) {
	fixtures := []struct {
		name, method, response string
		raw                    bool
	}{
		{"raw success", "page.evaluate", `{"ok":true,"result":{"value":"\u001b[31mred\u001b[0m <&>"},"meta":{}}`, true},
		{"sensitive exact", "sensitive.read", `{"ok":true,"result":{"value":"\u001b[31msecret\u001b[0m"},"meta":{"method":"sensitive.read"}}`, true},
		{"raw failure", "dom.query", `{"ok":false,"result":null,"error":{"code":"INVALID_REQUEST","message":"Bad \u001b[31mselector","details":null},"meta":{}}`, true},
		{"summary success", "", `{"ok":true,"result":{"clicked":true,"elementRef":"el_a"},"meta":{}}`, false},
		{"summary failure", "", `{"ok":false,"result":null,"error":{"code":"ELEMENT_STALE","message":"Gone","details":null},"meta":{}}`, false},
		{"wait false exits zero", "", `{"ok":true,"result":{"found":false,"duration":5000},"meta":{}}`, false},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			expected, err := decodeObject(readContractCase(t, "cli-printer", fixture.name))
			if err != nil {
				t.Fatal(err)
			}
			response, err := decodeObject([]byte(fixture.response))
			if err != nil {
				t.Fatal(err)
			}
			var out, stderr bytes.Buffer
			nativeErr := writeCLIResponse(response, fixture.raw, fixture.method, 1700000000000, &out, &stderr, false, false)
			assertJSONEqual(t, out.Bytes(), []byte(expected.text("stdout")))
			if stderr.String() != expected.text("stderr") {
				t.Fatalf("stderr: got %q want %q", stderr.String(), expected.text("stderr"))
			}
			if (nativeErr != nil) != expected.boolean("failed") {
				t.Fatalf("exit status: got %v, want failure %v", nativeErr, expected.boolean("failed"))
			}
		})
	}
}

func TestCLICallArgumentErrorContracts(t *testing.T) {
	fixtures := [][]string{{"call"}, {"call", "unknown.method"}, {"call", "page.get_state", "{"}, {"call", "page.get_state", "[]"}, {"call", "page.get_state", "null"}, {"call", "page.get_state", "true"}, {"call", "page.get_state", "3"}, {"call", "page.get_state", "{}", "{}"}, {"call", "page.get_state", "--tab", "0"}, {"call", "page.get_state", "--preset", "invalid"}, {"call", "page.get_state", "--extension"}}
	for _, args := range fixtures {
		name := strings.Join(args, " ")
		t.Run(name, func(t *testing.T) {
			_, nativeErr := parseCLI(args)
			if nativeErr == nil {
				t.Fatal("invalid arguments accepted")
			}
			assertJSONEqual(t, value(cliErrorPayload(nativeErr)), readContractCase(t, "cli-argument-errors", name))
		})
	}
}

func TestCLISummaryTabNoteOnlyForImplicitRouting(t *testing.T) {
	for routing, want := range map[string]bool{"": true, "working": true, "active": true, "explicit": false} {
		meta := object{"tab_id": value(5), "active_tab_id": value(7)}
		if routing != "" {
			meta["tab_routing"] = value(routing)
		}
		response := object{"ok": value(true), "result": value(object{"clicked": value(true)}), "meta": value(meta)}
		got := strings.Contains(cliText(cliSummarize(response, "input.click", 1700000000000), "summary"), "Ran in working tab 5")
		if got != want {
			t.Errorf("tab_routing %q: note = %v, want %v", routing, got, want)
		}
	}
}

func TestCLISummaryDOMQueryReportsOtherMatches(t *testing.T) {
	response := object{"ok": value(true), "result": value(object{"nodes": value([]object{{"tag": value("a")}}), "matchCount": value(14)})}
	text := cliText(cliSummarize(response, "dom.query", 1700000000000), "summary")
	if !strings.Contains(text, "The selector matched 14 elements") {
		t.Fatalf("summary should mention other matches: %s", text)
	}
	response = object{"ok": value(true), "result": value(object{"nodes": value([]object{{"tag": value("a")}})})}
	if text := cliText(cliSummarize(response, "dom.query", 1700000000000), "summary"); strings.Contains(text, "matched") {
		t.Fatalf("single match should not mention other matches: %s", text)
	}
}

func TestCLIJSONPreservesObjectEnumeration(t *testing.T) {
	for _, tc := range []struct {
		name, raw, want string
		sanitize        bool
	}{
		{"numeric keys", `{"z":0,"10":10,"2":2,"01":1,"4294967295":3,"0":4}`, `{"0":4,"2":2,"10":10,"z":0,"01":1,"4294967295":3}`, false},
		{"duplicate keys", `{"z":1,"a":2,"z":3}`, `{"z":3,"a":2}`, false},
		{"nested sanitized values", `{"outer":{"b":"\u001b[31mred\u001b[0m","1":{"z":1,"z":2}},"a":[{"2":2,"0":0}]}`, `{"outer":{"1":{"z":2},"b":"red"},"a":[{"0":0,"2":2}]}`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := string(cliJSON(json.RawMessage(tc.raw), tc.sanitize)); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
	for _, raw := range []string{`{"a":1`, `true`, `null`} {
		if keys := cliKeys(json.RawMessage(raw)); len(keys) != 0 {
			t.Fatalf("invalid object %s returned keys: %v", raw, keys)
		}
	}
}

func BenchmarkCLIJSONNestedResponse(b *testing.B) {
	nodes := make([]object, 25)
	for i := range nodes {
		nodes[i] = object{"elementRef": value("el_fixture"), "tag": value("button"), "attrs": value(object{"id": value("save"), "class": value("button primary")}), "textExcerpt": value("Save changes")}
	}
	raw := value(object{"ok": value(true), "result": value(object{"nodes": value(nodes), "count": value(len(nodes))})})
	b.ReportAllocs()
	b.SetBytes(int64(len(raw)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = cliJSON(raw, true)
	}
}

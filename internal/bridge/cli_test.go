package bridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// Captured wire contracts keep shortcut compatibility independent of an older runtime.
func TestCLIShortcutContracts(t *testing.T) {
	fixtures := []struct {
		args           []string
		method, params string
	}{
		{[]string{"access-request", "inspect"}, "access.request", `{"intent":"inspect"}`},
		{[]string{"dom-query"}, "dom.query", `{"selector":"body"}`},
		{[]string{"describe", "el_abc"}, "dom.describe", `{"target":{"elementRef":"el_abc"}}`},
		{[]string{"text", "main", "42"}, "dom.get_text", `{"target":{"selector":"main"},"textBudget":42}`},
		{[]string{"styles", "#hero", "color, font-size,,"}, "styles.get_computed", `{"target":{"selector":"#hero"},"properties":["color","font-size"]}`},
		{[]string{"box", "main"}, "layout.get_box_model", `{"target":{"selector":"main"}}`},
		{[]string{"click", "button", "right"}, "input.click", `{"target":{"selector":"button"},"button":"right"}`},
		{[]string{"focus", "input"}, "input.focus", `{"target":{"selector":"input"}}`},
		{[]string{"type", "input", "hello", "world"}, "input.type", `{"target":{"selector":"input"},"text":"hello world"}`},
		{[]string{"fill", "input", "hello", "world"}, "input.fill", `{"target":{"selector":"input"},"value":"hello world","mode":"auto"}`},
		{[]string{"hover", "a"}, "input.hover", `{"target":{"selector":"a"}}`},
		{[]string{"html", "main", "120"}, "dom.get_html", `{"target":{"selector":"main"},"maxLength":120}`},
		{[]string{"patch-style", "main", "color=red", "bad", " font-family = sans=serif "}, "patch.apply_styles", `{"target":{"selector":"main"},"declarations":{"color":"red","font-family":"sans=serif"}}`},
		{[]string{"patch-text", "main", "hello", "world"}, "patch.apply_dom", `{"target":{"selector":"main"},"operation":"set_text","value":"hello world"}`},
		{[]string{"patches"}, "patch.list", `{}`},
		{[]string{"rollback", "patch_1"}, "patch.rollback", `{"patchId":"patch_1"}`},
		{[]string{"console"}, "page.get_console", `{"level":"all","clear":false}`},
		{[]string{"wait", "button"}, "dom.wait_for", `{"selector":"button","timeoutMs":5000}`},
		{[]string{"find", "hello", "world"}, "dom.find_by_text", `{"text":"hello world"}`},
		{[]string{"find-role", "button", "Save", "changes"}, "dom.find_by_role", `{"role":"button","name":"Save changes"}`},
		{[]string{"navigate", "https://example.com"}, "navigation.navigate", `{"url":"https://example.com"}`},
		{[]string{"storage", "session", "one", "two"}, "page.get_storage", `{"type":"session","keys":["one","two"]}`},
		{[]string{"page-text", "300"}, "page.get_text", `{"textBudget":300}`},
		{[]string{"network", "10"}, "page.get_network", `{"limit":10}`},
		{[]string{"a11y-tree", "10", "3"}, "dom.get_accessibility_tree", `{"maxNodes":10,"maxDepth":3}`},
		{[]string{"perf"}, "performance.get_metrics", `{}`},
		{[]string{"scroll", "-10.5", "0"}, "viewport.scroll", `{"top":-10.5,"left":0}`},
		{[]string{"resize", "800", "600"}, "viewport.resize", `{"width":800,"height":600}`},
		{[]string{"reload"}, "navigation.reload", `{}`},
		{[]string{"back"}, "navigation.go_back", `{}`},
		{[]string{"forward"}, "navigation.go_forward", `{}`},
		{[]string{"attrs", "main", "id, role"}, "dom.get_attributes", `{"target":{"selector":"main"},"attributes":["id","role"]}`},
		{[]string{"matched-rules", "main"}, "styles.get_matched_rules", `{"target":{"selector":"main"}}`},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.args[0], func(t *testing.T) {
			request, err := parseCLI(fixture.args)
			if err != nil {
				t.Fatal(err)
			}
			if request.text("method") != fixture.method {
				t.Fatalf("method: %s", request.text("method"))
			}
			assertJSONEqual(t, request["params"], []byte(fixture.params))
		})
	}
}
func assertJSONEqual(t *testing.T, a, b []byte) {
	t.Helper()
	if !bytes.Equal(canonicalCLIJSON(t, a), canonicalCLIJSON(t, b)) {
		t.Fatalf("JSON mismatch\ngot: %s\nwant: %s", a, b)
	}
}
func canonicalCLIJSON(t *testing.T, raw []byte) []byte {
	t.Helper()
	raw = bytes.TrimSpace(raw)
	if !json.Valid(raw) {
		t.Fatalf("invalid JSON: %s", raw)
	}
	if len(raw) > 0 && raw[0] == '{' {
		var fields object
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		for key, item := range fields {
			fields[key] = canonicalCLIJSON(t, item)
		}
		return value(fields)
	}
	if len(raw) > 0 && raw[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			t.Fatal(err)
		}
		for i, item := range items {
			items[i] = canonicalCLIJSON(t, item)
		}
		return value(items)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		t.Fatal(err)
	}
	return compact.Bytes()
}
func TestCLIParsing(t *testing.T) {
	cases := []struct {
		args           []string
		method, params string
		tab            int64
	}{
		{[]string{"click", "--tab", "12", "--extension", "profile-1", "button"}, "input.click", `{"target":{"selector":"button"}}`, 12},
		{[]string{"call", "health.ping", "--tab", "12"}, "health.ping", `{}`, 0},
		{[]string{"intercept", "add", "*example*", "--respond", "", "--status", "201"}, "network.intercept.add", `{"urlPattern":"*example*","action":"fulfill","statusCode":201,"body":""}`, 0},
		{[]string{"eval", "--tab", "5", "--await", "Promise.resolve(1)"}, "page.evaluate", `{"expression":"Promise.resolve(1)","returnByValue":true,"awaitPromise":true}`, 5},
		{[]string{"press-key", "Enter", "el_field"}, "input.press_key", `{"key":"Enter","target":{"elementRef":"el_field"}}`, 0},
		{[]string{"tab-close", "123"}, "tabs.close", `{"tabId":123}`, 0},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			r, e := parseCLI(tc.args)
			if e != nil {
				t.Fatal(e)
			}
			if r.text("method") != tc.method || r.number("tab_id") != tc.tab {
				t.Fatalf("unexpected request: %s", value(r))
			}
			assertJSONEqual(t, r["params"], []byte(tc.params))
		})
	}
	for _, args := range [][]string{{"call"}, {"call", "unknown.method"}, {"call", "page.get_state", "[]"}, {"call", "page.get_state", "--tab", "0"}, {"resize", "0", "3"}, {"text"}, {"intercept", "add", "*", "--block", "--respond", "x"}, {"intercept", "add", "*", "--status", "600"}, {"batch"}, {"batch", "--preset", "bad", "[]"}} {
		if _, err := parseCLI(args); err == nil {
			t.Errorf("accepted invalid args %q", args)
		}
	}
	r, e := parseCLI([]string{"call", "dom.query", "--preset", "quick", `{"selector":"main","maxNodes":7}`})
	if e != nil {
		t.Fatal(e)
	}
	if r.object("params").number("maxNodes") != 7 {
		t.Fatal("preset overwrote explicit budget")
	}
	if len(r.object("params")) < 3 {
		t.Fatal("preset did not fill budget gaps")
	}
}
func TestRemoteConfigurationIsolation(t *testing.T) {
	c := config{home: t.TempDir(), network: "unix", address: "local.sock", agentToken: "unused"}
	token := strings.Repeat("a", 32)
	t.Setenv("BBX_AUTH_TOKEN", strings.Repeat("b", 32))
	if err := handleRemoteCommand(context.Background(), c, []string{"add", "test", "[::1]:1234", "--token", token}); err != nil {
		t.Fatal(err)
	}
	routed, err := destinationConfig(c, "test")
	if err != nil {
		t.Fatal(err)
	}
	got, err := routed.credential("agent")
	if err != nil || got != token || !routed.remote || routed.address != "[::1]:1234" {
		t.Fatalf("destination override failed: %#v %s %v", routed, got, err)
	}
	if c.remote || c.token != "" || c.address != "local.sock" {
		t.Fatal("routing mutated base config")
	}
	if _, err = destinationConfig(c, "missing"); err == nil {
		t.Fatal("unknown destination accepted")
	}
	stat, err := os.Stat(filepath.Join(c.home, "remotes.json"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && stat.Mode().Perm() != 0600 {
		t.Fatalf("credentials permissions: %o", stat.Mode().Perm())
	}
	if err = handleRemoteCommand(context.Background(), c, []string{"remove", "test"}); err != nil {
		t.Fatal(err)
	}
	remotes, err := readRemoteConfig(c)
	if err != nil || len(remotes.Remotes) != 0 {
		t.Fatalf("remove: %#v %v", remotes, err)
	}
	for _, name := range []string{"local", "../bad", "", "white space"} {
		if _, err := normalizeDestinationID(name); err == nil {
			t.Errorf("accepted %q", name)
		}
	}
	for _, endpoint := range []string{"host:0", "host:65536", "host:abc", "https://host", "bad host:9223"} {
		if _, _, err := parseRemoteEndpoint(endpoint); err == nil {
			t.Errorf("accepted endpoint %q", endpoint)
		}
	}
}
func TestCLIProxySettings(t *testing.T) {
	original := &proxyConfig{Enabled: true, Port: 3333, BindHost: "127.0.0.1", Token: strings.Repeat("a", 32)}
	p, err := resolveProxySettings(original, nil)
	if err != nil || p != *original {
		t.Fatalf("idempotence: %#v %v", p, err)
	}
	rotated, err := resolveProxySettings(original, []string{"--rotate-token"})
	if err != nil || rotated.Token == p.Token || rotated.Port != p.Port {
		t.Fatal("token rotation failed")
	}
	if _, err := resolveProxySettings(nil, []string{"--bind-host", "0.0.0.0"}); err == nil {
		t.Fatal("unacknowledged non-loopback bind accepted")
	}
	if _, err := resolveProxySettings(nil, []string{"--bind-host", "0.0.0.0", "--unsafe-plaintext"}); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveProxySettings(original, []string{"--token", original.Token, "--rotate-token"}); err == nil {
		t.Fatal("conflicting token options accepted")
	}
	if _, err := resolveProxySettings(nil, []string{"--port", "65536"}); err == nil {
		t.Fatal("invalid port accepted")
	}
}

func TestCLILoadConfigTransportPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("BROWSER_BRIDGE_HOME", home)
	t.Setenv("BBX_TCP_PORT", "")
	t.Setenv("BBX_TCP_HOST", "")
	t.Setenv("BBX_TCP_BIND_HOST", "")
	t.Setenv("BBX_AUTH_TOKEN_FILE", "")
	t.Setenv("BBX_REMOTE", "ignored-until-routing")
	p := proxyConfig{Enabled: true, Port: 19999, BindHost: "127.0.0.2", Token: strings.Repeat("x", 32)}
	if err := writeCLIJSON(filepath.Join(home, "proxy.json"), p); err != nil {
		t.Fatal(err)
	}
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.network != "tcp" || c.address != "127.0.0.1:19999" || c.bind != "127.0.0.2:19999" || c.agentToken != filepath.Join(home, "daemon.auth") {
		t.Fatalf("bad persisted proxy configuration: %#v", c)
	}
	t.Setenv("BBX_TCP_PORT", "20001")
	t.Setenv("BBX_TCP_HOST", "localhost")
	c, err = loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.address != "localhost:20001" || c.bind != "localhost:20001" {
		t.Fatalf("explicit transport did not win: %#v", c)
	}
	t.Setenv("BBX_TCP_PORT", "0")
	if _, err = loadConfig(); err == nil {
		t.Fatal("invalid explicit TCP port accepted")
	}
}

func TestCLIUploadFailureReleasesEarlierHandles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "empty.txt")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	released := false
	call := func(_ context.Context, method string, p object) (object, error) {
		switch method {
		case "files.stage":
			if p.number("size") != 0 || p.text("data") != "" {
				t.Fatal("empty upload was not staged")
			}
			return object{"transferId": value("empty"), "nextOffset": value(0)}, nil
		case "input.set_files":
			return nil, errors.New("input rejected files")
		case "files.release":
			released = true
			return object{}, nil
		}
		t.Fatalf("unexpected method %s", method)
		return nil, nil
	}
	if _, err := uploadCLIFiles(context.Background(), call, object{"selector": value("input")}, []string{path}, "input.set_files"); err == nil || !released {
		t.Fatal("failed upload did not release staged bytes", err, released)
	}
}

func TestCLIRecordUsesOneSequenceAndExports(t *testing.T) {
	output := filepath.Join(t.TempDir(), "recording.json")
	data := []byte(`{"frames":[],"events":[]}`)
	sum := sha256.Sum256(data)
	methods := []string{}
	call := func(_ context.Context, method string, p object) (object, error) {
		methods = append(methods, method)
		switch method {
		case "session.start":
			return object{"sessionId": value("session_1"), "nextCursor": value(12)}, nil
		case "session.read":
			if p.number("cursor") != 12 || p.number("waitMs") != 25000 {
				t.Fatal("recording read lost its cursor")
			}
			return object{"active": value(false), "nextCursor": value(13)}, nil
		case "session.export":
			return object{"artifact": value(object{"artifactId": value("recording_1"), "kind": value("resource"), "byteLength": value(len(data)), "sha256": value(hex.EncodeToString(sum[:]))}), "gaps": value(2), "dropped": value(3)}, nil
		case "artifact.read":
			return object{"artifactId": value("recording_1"), "offset": value(0), "byteLength": value(len(data)), "data": value(base64.StdEncoding.EncodeToString(data)), "nextOffset": []byte("null")}, nil
		case "artifact.delete", "session.release":
			return object{}, nil
		}
		return nil, errors.New("unexpected recording method")
	}
	result, err := recordCLI(context.Background(), call, object{}, output)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(output)
	if err != nil || !bytes.Equal(saved, data) || result.number("gaps") != 2 || result.number("dropped") != 3 {
		t.Fatal("recording export mismatch", err)
	}
	want := []string{"session.start", "session.read", "session.export", "artifact.read", "artifact.delete", "session.release"}
	if !reflect.DeepEqual(methods, want) {
		t.Fatalf("recording flow: %v", methods)
	}
}

func TestCLIInvalidCaptureDoesNotDispatch(t *testing.T) {
	called := false
	call := func(context.Context, string, object) (object, error) {
		called = true
		return nil, errors.New("unexpected dispatch")
	}
	for _, args := range [][]string{{"--format", "jpeg", "main", "image.png"}, {"--quality", "101", "main"}, {"--format", "svg", "main"}} {
		if err := screenshotCLI(context.Background(), call, args); err == nil {
			t.Fatal("invalid screenshot options accepted", args)
		}
	}
	if err := harCLI(context.Background(), call, []string{"output.json"}); err == nil {
		t.Fatal("invalid HAR extension accepted")
	}
	if called {
		t.Fatal("invalid capture arguments reached the browser")
	}
	if err := validateCLIHAR([]byte(`{"log":{"version":"1.2","entries":[]}}`)); err != nil {
		t.Fatal(err)
	}
	if err := validateCLIHAR([]byte(`{"log":{"version":"1.1","entries":[]}}`)); err == nil {
		t.Fatal("invalid HAR version accepted")
	}
}
func TestCLIConfigLocalRemoteRules(t *testing.T) {
	t.Setenv("BBX_REMOTE", "ambient")
	name, explicit, args, err := extractRemote([]string{"status", "--remote", "selected"})
	if err != nil || name != "selected" || !explicit || !reflect.DeepEqual(args, []string{"status"}) {
		t.Fatal(name, explicit, args, err)
	}
	if err = run(context.Background(), []string{"config", "get", "auto-update", "--remote", "selected"}); err == nil {
		t.Fatal("local command accepted --remote")
	}
	c := config{home: t.TempDir()}
	if err = writeCLIJSON(filepath.Join(c.home, "config.json"), object{"custom": value("preserved")}); err != nil {
		t.Fatal(err)
	}
	if err = handleConfigCommand(c, []string{"set", "auto-update", "compatible"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(c.home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, b, []byte(`{"custom":"preserved","autoUpdate":"compatible"}`))
}
func TestCLIArtifactIntegrityAndCleanup(t *testing.T) {
	data := []byte("browser bytes")
	sum := sha256.Sum256(data)
	descriptor := object{"artifactId": value("artifact_1"), "kind": value("resource"), "byteLength": value(len(data)), "sha256": value(hex.EncodeToString(sum[:]))}
	for _, corrupt := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "checksum"}[corrupt], func(t *testing.T) {
			deleted := false
			reads := 0
			call := func(_ context.Context, method string, p object) (object, error) {
				if method == "artifact.delete" {
					deleted = true
					return object{}, nil
				}
				if method != "artifact.read" {
					t.Fatalf("unexpected method %s", method)
				}
				reads++
				offset := p.number("offset")
				chunk := data[offset:min(offset+4, int64(len(data)))]
				if corrupt {
					chunk = bytes.Repeat([]byte("x"), len(chunk))
				}
				next := offset + int64(len(chunk))
				r := object{"artifactId": value("artifact_1"), "offset": value(offset), "data": value(base64.StdEncoding.EncodeToString(chunk)), "byteLength": value(len(chunk)), "nextOffset": value(next)}
				if next == int64(len(data)) {
					r["nextOffset"] = []byte("null")
				}
				return r, nil
			}
			out, err := downloadCLIArtifact(context.Background(), call, descriptor, "resource")
			if corrupt && err == nil {
				t.Fatal("accepted corrupt artifact")
			}
			if !corrupt && (err != nil || !bytes.Equal(out, data)) {
				t.Fatal(string(out), err)
			}
			if !deleted || reads < 2 {
				t.Fatal("artifact not read in chunks and deleted")
			}
		})
	}
}
func TestCLIUploadChunksAndCleanup(t *testing.T) {
	dir := t.TempDir()
	data := bytes.Repeat([]byte("z"), 196608+7)
	path := filepath.Join(dir, "payload.txt")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	var uploaded []byte
	released, assigned := false, false
	call := func(_ context.Context, method string, p object) (object, error) {
		switch method {
		case "files.stage":
			chunk, err := decodeCLIBase64(p.text("data"))
			if err != nil {
				t.Fatal(err)
			}
			if p.number("offset") != int64(len(uploaded)) || len(chunk) > 196608 {
				t.Fatalf("bad chunk: %s", value(p))
			}
			uploaded = append(uploaded, chunk...)
			return object{"transferId": value("file_1"), "nextOffset": value(len(uploaded))}, nil
		case "input.set_files":
			assigned = true
			assertJSONEqual(t, p["files"], []byte(`["file_1"]`))
			return object{"assigned": value(true)}, nil
		case "files.release":
			released = true
			return object{}, nil
		}
		return nil, errors.New("unexpected upload method")
	}
	if _, err := uploadCLIFiles(context.Background(), call, object{"selector": value("input")}, []string{path}, "input.set_files"); err != nil {
		t.Fatal(err)
	}
	if !assigned || !released || !bytes.Equal(uploaded, data) {
		t.Fatal("upload did not preserve bytes or release its handle")
	}
}
func TestCLIReplayRecovery(t *testing.T) {
	data := []byte("{\"kind\":\"event\",\"event\":{\"seq\":1,\"type\":\"click\",\"at\":100,\"origin\":\"trusted-event\",\"tabId\":1}}\n{\"kind\":\"event\",\"event\":{\"seq\":2,\"type\":\"request\",\"at\":200,\"tabId\":1}}\n{\"kind\":\"event-update\",\"event\":{\"seq\":2,\"type\":\"request\",\"at\":200,\"tabId\":1,\"status\":200}}\n{\"kind\":\"end\",\"gaps\":2,\"dropped\":3}\npartial")
	r, err := parseCLIRecording(data)
	if err != nil {
		t.Fatal(err)
	}
	if r.Gaps != 3 || r.Dropped != 3 || len(r.Events) != 2 || r.Events[1].number("status") != 200 || r.Events[1].object("correlation").number("actionSeq") != 1 {
		t.Fatalf("journal recovery: %s", value(r))
	}
	r.Events = append(r.Events, object{"text": value("</script><script>alert(1)</script>")})
	html := renderCLIReplay(r)
	if strings.Contains(html, "</script><script>alert(1)") || !strings.Contains(html, `\u003c/script\u003e`) {
		t.Fatal("untrusted replay text escaped script boundary")
	}
	output := filepath.Join(t.TempDir(), "replay.html")
	source := filepath.Join(t.TempDir(), "journal.jsonl")
	if err = os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	called := false
	_, err = exportCLIReplay(context.Background(), func(context.Context, string, object) (object, error) {
		called = true
		return nil, errors.New("unexpected network")
	}, source, output)
	if err != nil || called {
		t.Fatal("local replay unexpectedly used daemon", err)
	}
}

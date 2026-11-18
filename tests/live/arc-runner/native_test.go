package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestArcNativeReplyRequiresThisRunsNonceAndLocation(t *testing.T) {
	proof := manifestProof{Location: "/disposable/NativeMessagingHosts", Nonce: "per-run-nonce"}
	for _, input := range []string{
		`{}`, `null`, `not JSON`, `{"error":"host exited"}`,
		`{"location":"/disposable/NativeMessagingHosts","nonce":"old-run"}`,
		`{"location":"/personal/NativeMessagingHosts","nonce":"per-run-nonce"}`,
	} {
		if err := validateNativeReply([]byte(input), proof); err == nil {
			t.Errorf("unproven lookup accepted: %s", input)
		}
	}
	if err := validateNativeReply([]byte(`{"location":"/disposable/NativeMessagingHosts","nonce":"per-run-nonce"}`), proof); err != nil {
		t.Fatal(err)
	}
}

func TestArcNativeProbeSelectsTheDirectoryThatAnswered(t *testing.T) {
	arc := manifestProof{Location: "/disposable/Arc/User Data/NativeMessagingHosts", Nonce: "arc-nonce"}
	chrome := manifestProof{Location: "/disposable/Google/Chrome/NativeMessagingHosts", Nonce: "chrome-nonce"}
	candidates := []manifestProof{arc, chrome}

	for _, want := range candidates {
		data, err := json.Marshal(nativeReply{Location: want.Location, Nonce: want.Nonce})
		if err != nil {
			t.Fatal(err)
		}
		if got, err := selectNativeProbe(data, candidates); err != nil || got != want {
			t.Fatalf("selected %+v, want %+v; error: %v", got, want, err)
		}
	}

	mismatch, err := json.Marshal(nativeReply{Location: chrome.Location, Nonce: arc.Nonce})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := selectNativeProbe(mismatch, candidates); err == nil {
		t.Fatal("accepted a location paired with another directory's nonce")
	}
}

func TestArcDiagnosticHostUsesNativeMessagingFraming(t *testing.T) {
	var output bytes.Buffer
	reply := nativeReply{Location: "/disposable/NativeMessagingHosts", Nonce: "nonce"}
	if err := serveProbeHost(&output, strings.NewReader(""), reply, "arc-lookup"); err != nil {
		t.Fatal(err)
	}
	length := binary.LittleEndian.Uint32(output.Bytes()[:4])
	data := output.Bytes()[4:]
	var decoded nativeReply
	if int(length) != len(data) || json.Unmarshal(data, &decoded) != nil || decoded != reply {
		t.Fatalf("invalid native reply: %x", output.Bytes())
	}
	if err := serveProbeHost(&output, strings.NewReader(""), reply, "other-role"); err == nil {
		t.Fatal("unexpected role accepted")
	}
}

func TestArcBridgeRequiresObservedHealthConnection(t *testing.T) {
	for _, data := range []string{`{}`, `{"ok":true}`, `{"manifestCreated":true}`, `{"extensionConnected":false}`, `{"extensionConnected":true}`, `invalid`} {
		if err := validateBridgeHealth([]byte(data)); err == nil {
			t.Errorf("bridge connection inferred without health evidence: %s", data)
		}
	}
	if err := validateBridgeHealth([]byte(`{"daemon":"ok","extensionConnected":true}`)); err != nil {
		t.Fatal(err)
	}
}

func TestArcEnvironmentDoesNotInheritRealHomeRemoteOrCredentials(t *testing.T) {
	env := isolatedEnvironment([]string{
		"HOME=/personal", "CFFIXED_USER_HOME=/personal", "PATH=/usr/bin",
		"BBX_REMOTE=personal", "BBX_TCP_HOST=external.example", "BBX_TCP_PORT=9223",
		"BBX_AUTH_TOKEN=do-not-inherit", "BBX_AUTH_TOKEN_FILE=/personal/token",
		"BROWSER_BRIDGE_HOME=/personal/bridge", "CHROME_CONFIG_HOME=/personal/chrome",
	}, "/isolated/home", "/isolated/bridge", "12345")
	want := []string{
		"PATH=/usr/bin", "HOME=/isolated/home", "CFFIXED_USER_HOME=/isolated/home",
		"BROWSER_BRIDGE_HOME=/isolated/bridge", "BBX_AUTO_UPDATE=off",
		"BBX_TCP_HOST=127.0.0.1", "BBX_TCP_BIND_HOST=127.0.0.1", "BBX_TCP_PORT=12345",
	}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("environment=%v", env)
	}
}

func TestArcPrivateExtensionIDMatchesItsKey(t *testing.T) {
	key, id, err := privateExtensionKey()
	if err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	var want strings.Builder
	for _, value := range hash[:16] {
		want.WriteByte('a' + (value >> 4))
		want.WriteByte('a' + (value & 15))
	}
	if id != want.String() || len(id) != 32 {
		t.Fatalf("private extension ID=%s want=%s", id, want.String())
	}
}

func TestArcProbeFilesNeverOverwriteExistingRegistrations(t *testing.T) {
	file := filepath.Join(t.TempDir(), "host.json")
	if err := writeExclusive(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusive(file, []byte("replacement"), 0600); err == nil {
		t.Fatal("existing registration overwritten")
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "original" {
		t.Fatalf("data=%q err=%v", data, err)
	}
}

func TestArcManifestDestinationMustStayInsideDisposableRoot(t *testing.T) {
	runner := arcRunner{root: t.TempDir()}
	outside := filepath.Join(t.TempDir(), "host.json")
	if err := runner.writeManifest(outside, nativeManifest{Name: "test"}); err == nil {
		t.Fatal("manifest written outside the disposable run")
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatal("external manifest was created")
	}
}

package bridge

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"syscall"
	"testing"
)

func TestOversizedAgentResponseBecomesTypedFailure(t *testing.T) {
	big := strings.Repeat("x", maxMessageBytes)
	envelope := agentResponseEnvelope(success("req-1", object{"value": value(big)}))
	response, err := decodeObject(envelope["response"])
	if err != nil {
		t.Fatal(err)
	}
	if response.boolean("ok") || response.object("error").text("code") != "RESULT_TOO_LARGE" || response.text("id") != "req-1" {
		t.Fatalf("oversized response not replaced: %s", envelope["response"][:200])
	}
	small := agentResponseEnvelope(success("req-2", object{"value": value("ok")}))
	if !bytes.Contains(small["response"], []byte(`"ok":true`)) {
		t.Fatalf("small response changed: %s", small["response"])
	}
}

func TestOversizedExtensionResultFailsOnlyThatRequest(t *testing.T) {
	var toDaemon, toExtension bytes.Buffer
	daemonWriter := &wireWriter{out: &toDaemon, lineLimit: maxWireLineBytes}
	extensionWriter := &wireWriter{out: &toExtension, native: true}
	relayOversizedFromExtension(object{"id": value("agent-7"), "ok": value(true)}, daemonWriter, extensionWriter)
	message, err := readWireLine(bufio.NewReader(&toDaemon))
	if err != nil {
		t.Fatal(err)
	}
	response := message.object("response")
	if message.text("type") != "extension.response" || response.text("id") != "agent-7" || response.object("error").text("code") != "RESULT_TOO_LARGE" {
		t.Fatalf("unexpected relay reply: %v", message)
	}
	if toExtension.Len() != 0 {
		t.Fatal("a result reply must not go back to the extension")
	}
}

func TestOversizedNativeFrameIsSkippedWithoutBreakingTheStream(t *testing.T) {
	var stream bytes.Buffer
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(maxMessageBytes+10))
	stream.Write(header[:])
	stream.Write(bytes.Repeat([]byte("a"), maxMessageBytes+10))
	next := []byte(`{"type":"host.identity"}`)
	binary.LittleEndian.PutUint32(header[:], uint32(len(next)))
	stream.Write(header[:])
	stream.Write(next)
	if _, err := readNative(&stream); !errors.Is(err, errNativeFrameTooLarge) {
		t.Fatalf("first frame error = %v", err)
	}
	message, err := readNative(&stream)
	if err != nil || message.text("type") != "host.identity" {
		t.Fatalf("next frame = %v, %v", message, err)
	}
}

func TestDialFailuresAreTypedAsDaemonUnavailable(t *testing.T) {
	err := wrapDialError(syscall.ECONNREFUSED)
	if !isDaemonUnavailable(err) || !mcpConnectionLost(err) {
		t.Fatalf("dial error not typed: %v", err)
	}
	result := toolResult(nil, err)
	if !strings.Contains(string(rawObject(result)), "DAEMON_UNAVAILABLE") {
		t.Fatalf("tool result does not carry DAEMON_UNAVAILABLE: %s", rawObject(result))
	}
	if !connectionLost(errors.New("Bridge socket closed")) || connectionLost(errors.New("bad request")) {
		t.Fatal("connectionLost classification")
	}
}

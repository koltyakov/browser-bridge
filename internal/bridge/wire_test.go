package bridge

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return w.Buffer.Write(p)
}

func TestNativeFramesRemainAtomicAcrossConcurrentShortWrites(t *testing.T) {
	out := &shortWriter{}
	w := &wireWriter{out: out, native: true}
	var writers sync.WaitGroup
	for i := 0; i < 20; i++ {
		writers.Add(1)
		go func(i int) {
			defer writers.Done()
			if err := w.send(object{"id": value(i), "text": value("multibyte: 日本語")}); err != nil {
				t.Error(err)
			}
		}(i)
	}
	writers.Wait()
	seen := make(map[int64]bool)
	for i := 0; i < 20; i++ {
		message, err := readNative(&out.Buffer)
		if err != nil {
			t.Fatal(err)
		}
		if message.text("text") != "multibyte: 日本語" {
			t.Fatal("UTF-8 payload corrupted")
		}
		seen[message.number("id")] = true
	}
	if len(seen) != 20 || out.Len() != 0 {
		t.Fatal("frames interleaved, missing, or duplicated")
	}
}

func TestWireUsesNodeCompatibleHTMLEncoding(t *testing.T) {
	var output bytes.Buffer
	writer := wireWriter{out: &output}
	if err := writer.send(object{"html": value("<a href='/?a=1&b=2'>日本語</a>")}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), `\u003c`) || strings.Contains(output.String(), `\u0026`) {
		t.Fatalf("wire encoding inflated HTML bytes: %s", output.String())
	}
}

func TestFramingRejectsTruncationAndOversizedPayloads(t *testing.T) {
	if _, err := readLine(bufio.NewReader(strings.NewReader(`{"id":"unfinished"}`))); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("accepted incomplete JSON line: %v", err)
	}
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, maxMessageBytes+1)
	if _, err := readNative(bytes.NewReader(header)); err == nil {
		t.Fatal("accepted oversized native frame")
	}
	binary.LittleEndian.PutUint32(header, 8)
	if _, err := readNative(bytes.NewReader(append(header, '{'))); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("accepted truncated native frame: %v", err)
	}
	if _, err := readLine(bufio.NewReader(strings.NewReader(strings.Repeat(" ", maxMessageBytes) + "\n"))); err == nil {
		t.Fatal("accepted oversized JSON line")
	}
}

func TestFramingAcceptsExactNodePayloadLimit(t *testing.T) {
	message := object{"data": value(strings.Repeat("x", maxMessageBytes-len(value(object{"data": value("")}))))}
	for _, native := range []bool{false, true} {
		var buffer bytes.Buffer
		writer := wireWriter{out: &buffer, native: native}
		if err := writer.send(message); err != nil {
			t.Fatalf("native=%t: %v", native, err)
		}
		var decoded object
		var err error
		if native {
			decoded, err = readNative(&buffer)
		} else {
			decoded, err = readLine(bufio.NewReader(&buffer))
		}
		if err != nil || !bytes.Equal(decoded["data"], message["data"]) {
			t.Fatalf("native=%t: exact-limit round trip failed: %v", native, err)
		}
	}
}

func TestDaemonQueueAcceptsExactPayloadLimit(t *testing.T) {
	local, remote := net.Pipe()
	defer func() { _ = local.Close() }()
	defer func() { _ = remote.Close() }()
	p := &peer{conn: local, out: make(chan queuedMessage, 1), done: make(chan struct{})}
	message := object{"data": value(strings.Repeat("x", maxMessageBytes-len(value(object{"data": value("")}))))}
	if !p.enqueue(message, nil) {
		t.Fatal("daemon rejected an exact-limit payload")
	}
	queued := <-p.out
	if queued.bytes != maxMessageBytes+1 || p.queuedBytes.Load() != queued.bytes {
		t.Fatal("queue must account for the newline separately from the payload limit")
	}
}

func TestNativeControlMessagesPreserveOwnershipAndPayloads(t *testing.T) {
	for _, kind := range []string{"host.identity", "host.access_update", "host.artifact.begin", "host.journal.append", "host.window_action.result"} {
		message := object{"type": value(kind), "ownerId": value("owner-1"), "data": value("AA==")}
		translated := nativeToDaemon(message)
		if translated.text("type") != strings.Replace(kind, "host.", "extension.", 1) || translated.text("ownerId") != "owner-1" || translated.text("data") != "AA==" {
			t.Fatalf("lost native control data: %s", value(translated))
		}
	}
	message := daemonToNative(object{"type": value("extension.owner_disconnected"), "ownerId": value("owner-1")})
	if message.text("type") != "host.owner_disconnected" || message.text("ownerId") != "owner-1" {
		t.Fatal("lost owner disconnect event")
	}
}

func TestBootstrapDoesNotStartLocalDaemonForLoopbackRemote(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(t.TempDir(), "must-not-be-created")
	if err := bootstrap(config{home: home, network: "tcp", address: address, remote: true}); err == nil {
		t.Fatal("disconnected remote unexpectedly bootstrapped")
	}
	if _, err := os.Stat(home); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("remote bootstrap touched local runtime: %v", err)
	}
}

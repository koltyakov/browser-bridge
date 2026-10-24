package bridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type shortWriter struct{ bytes.Buffer }

func (w *shortWriter) Write(p []byte) (int, error) {
	if len(p) > 3 {
		p = p[:3]
	}
	return w.Buffer.Write(p)
}

func TestWireCanceledFrameDoesNotWriteOrConsumeTheNextDeadline(t *testing.T) {
	local, remote := net.Pipe()
	t.Cleanup(func() { _ = local.Close(); _ = remote.Close() })
	writer := wireWriter{out: local}
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	finished := make(chan error, 1)
	go func() {
		close(started)
		_, err := writer.sendContext(ctx, object{"id": value("blocked")})
		finished <- err
	}()
	<-started
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation was not surfaced: %v", err)
	}
	// A canceled writer joins its deadline callback before another frame starts.
	read := make(chan error, 1)
	go func() {
		_, err := readLine(bufio.NewReader(remote))
		read <- err
	}()
	if err := writer.send(object{"id": value("next")}); err != nil {
		t.Fatalf("stale cancellation corrupted the next write: %v", err)
	}
	if err := <-read; err != nil {
		t.Fatal(err)
	}
}

func TestWireQueuedCancellationReturnsWithoutWaitingForWriter(t *testing.T) {
	var output bytes.Buffer
	writer := wireWriter{out: &output}
	writer.once.Do(func() { writer.turn = make(chan struct{}, 1) })
	writer.turn <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	started, err := writer.sendContext(ctx, object{"id": value("must-not-send")})
	if started || !errors.Is(err, context.DeadlineExceeded) || output.Len() != 0 {
		t.Fatalf("queued frame was dispatched after cancellation: started=%t err=%v", started, err)
	}
	<-writer.turn
}

func FuzzJSONLineReader(f *testing.F) {
	for _, seed := range []string{"{}\n", "{\"text\":\"日本語\"}\n", "null\n", "[]\n", "{\"unfinished\":"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) > maxMessageBytes+2 {
			t.Skip()
		}
		message, err := readLine(bufio.NewReader(strings.NewReader(input)))
		if err == nil && message == nil {
			t.Fatal("reader accepted a non-object")
		}
	})
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
	for _, kind := range []string{"host.identity", "host.access_update", "host.artifact.begin", "host.journal.append", "host.window_action.result", "host.mutation_ready"} {
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
	grant := daemonToNative(object{"type": value("extension.mutation_granted"), "requestId": value("request-1")})
	if grant.text("type") != "host.mutation_granted" || grant.text("requestId") != "request-1" {
		t.Fatal("lost mutation scheduling grant")
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

func TestSkipOversizedLineResumesAtNextMessage(t *testing.T) {
	for _, terminated := range []bool{false, true} {
		// With a 4 KiB buffer, the first line overflows in the middle; the second
		// overflows only in the chunk that contains its newline.
		line := strings.Repeat("x", maxMessageBytes+3*4096)
		if terminated {
			line = strings.Repeat("x", maxMessageBytes+10)
		}
		reader := bufio.NewReaderSize(strings.NewReader(line+"\n"+`{"id":"next"}`+"\n"), 4096)
		_, err := readLine(reader)
		var oversized *oversizedLineError
		if !errors.As(err, &oversized) || oversized.terminated != terminated {
			t.Fatalf("expected an oversized-line error (terminated=%v), got %#v", terminated, err)
		}
		if err := skipOversizedLine(reader, err); err != nil {
			t.Fatal(err)
		}
		next, err := readLine(reader)
		if err != nil || next.text("id") != "next" {
			t.Fatalf("reader did not resume at the next message: %v %v", next, err)
		}
	}
}

func TestRawObjectMatchesCompactEncoding(t *testing.T) {
	decoded, err := decodeObject([]byte(`{"z":1,"a":{"b":[1,2]},"m":"<&>","n":null}`))
	if err != nil {
		t.Fatal(err)
	}
	decoded["added"] = value(object{"x": value("y")})
	if got, want := string(rawObject(decoded)), string(value(decoded)); got != want {
		t.Fatalf("raw encoding differs:\n got %s\nwant %s", got, want)
	}
	if got := string(rawObject(object{})); got != "{}" {
		t.Fatalf("empty object encoded as %s", got)
	}
}

func TestRawObjectFallsBackForUnsafeValues(t *testing.T) {
	for name, o := range map[string]object{
		"newline":   {"a": json.RawMessage("{\n\"b\":1}")},
		"missing":   {"a": nil},
		"quotedKey": {`a"b`: value(1)},
	} {
		raw := rawObject(o)
		if bytes.IndexByte(raw, '\n') >= 0 || !json.Valid(raw) || string(raw) != string(value(o)) {
			t.Fatalf("%s: unsafe value was copied verbatim: %q", name, raw)
		}
	}
}

func BenchmarkDaemonResponseRelay(b *testing.B) {
	response := object{"id": value("abc"), "ok": value(true), "result": value(object{"html": value(strings.Repeat("x", 900*1024))}), "meta": value(object{})}
	line := append(value(object{"type": value("extension.response"), "response": value(response)}), '\n')
	b.SetBytes(int64(len(line)))
	b.ReportAllocs()
	for b.Loop() {
		message, err := readLine(bufio.NewReader(bytes.NewReader(line)))
		if err != nil {
			b.Fatal(err)
		}
		body := envelopeBody(message)
		body["meta"] = value(object{"method": value("dom.get_html")})
		_ = rawObject(object{"type": value("agent.response"), "response": rawObject(body)})
	}
}

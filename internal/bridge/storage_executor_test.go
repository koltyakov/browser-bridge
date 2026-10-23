package bridge

import (
	"bytes"
	"encoding/base64"
	"net"
	"strings"
	"testing"
	"time"
)

func TestLegacyArtifactStreamsBeyondQueueByteLimit(t *testing.T) {
	d := serviceTestDaemon(t)
	d.storage = &storageExecutor{}
	t.Cleanup(d.storage.workers.Wait)
	d.agentToken, d.extensionToken = strings.Repeat("a", 43), strings.Repeat("e", 43)
	extension, extensionReader := serviceWirePeer(t, d, "extension")
	agent, agentReader := serviceWirePeer(t, d, "agent")
	send := func(writer *wireWriter, message object) {
		t.Helper()
		if err := writer.send(message); err != nil {
			t.Fatal(err)
		}
	}
	request := newRequest("screenshot.capture_region", object{"delivery": value("artifact")}, nil, 1)
	send(agent, object{"type": value("agent.request"), "request": value(request)})
	routed, err := readLine(extensionReader)
	if err != nil {
		t.Fatal(err)
	}
	id := routed.object("request").text("id")
	data := bytes.Repeat([]byte("x"), 5*maxMessageBytes)
	a := artifactTestDescriptor("l", data)
	a["requestId"] = value(id)
	send(extension, object{"type": value("extension.artifact.begin"), "artifact": value(a)})
	for offset, index := 0, 0; offset < len(data); offset, index = offset+int(artifactChunkBytes), index+1 {
		end := min(len(data), offset+int(artifactChunkBytes))
		send(extension, object{"type": value("extension.artifact.chunk"), "artifact": value(object{"requestId": value(id)}), "artifactId": a["artifactId"], "chunkIndex": value(index), "data": value(base64.StdEncoding.EncodeToString(data[offset:end]))})
	}
	send(extension, object{"type": value("extension.artifact.commit"), "artifact": value(object{"requestId": value(id)}), "artifactId": a["artifactId"]})
	send(extension, object{"type": value("extension.response"), "response": value(success(id, object{"delivery": value("artifact"), "artifact": value(a)}))})
	response, err := readLine(agentReader)
	if err != nil || !response.object("response").boolean("ok") {
		t.Fatalf("legacy transfer failed: %s %v", value(response), err)
	}
}

func BenchmarkDaemonHealthWhileStorageBlocked(b *testing.B) {
	d := &daemon{config: config{home: b.TempDir()}, peers: make(map[*peer]bool), pending: make(map[string]*pendingRequest), started: time.Now(), storage: &storageExecutor{}}
	d.initServices()
	conn, other := net.Pipe()
	defer func() { _ = conn.Close(); _ = other.Close() }()
	agent := &peer{conn: conn, out: make(chan queuedMessage, 32), done: make(chan struct{}), role: "agent", owner: uniqueID(), dataTargets: make(map[*peer]bool)}
	d.peers[agent] = true
	blocked, release := make(chan struct{}), make(chan struct{})
	defer d.storage.workers.Wait()
	defer close(release)
	d.storage.submit(0, false, func() { close(blocked); <-release })
	<-blocked
	request := newRequest("health.ping", nil, nil, 0)
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		d.mu.Lock()
		d.route(agent, request)
		d.mu.Unlock()
		item := <-agent.out
		agent.queuedBytes.Add(-item.bytes)
	}
}

func TestStorageDoesNotBlockDaemonRouting(t *testing.T) {
	d := serviceTestDaemon(t)
	d.storage = &storageExecutor{}
	agent := serviceTestPeer(t, d, "agent")
	blocked, release := make(chan struct{}), make(chan struct{})
	defer d.storage.workers.Wait()
	defer close(release)
	d.storage.submit(0, false, func() { close(blocked); <-release })
	<-blocked
	d.mu.Lock()
	d.handle(agent, object{"type": value("agent.request"), "request": value(newRequest("health.ping", nil, nil, 0))})
	d.mu.Unlock()
	if !serviceNextMessage(t, agent).object("response").boolean("ok") {
		t.Fatal("storage blocked health routing")
	}
}

func TestStorageQueueBoundsAndCleanupReservation(t *testing.T) {
	s := &storageExecutor{}
	blocked, release := make(chan struct{}), make(chan struct{})
	defer s.workers.Wait()
	defer close(release)
	s.submit(0, false, func() { close(blocked); <-release })
	<-blocked
	for i := 0; i < 256; i++ {
		if !s.submit(0, false, func() {}) {
			t.Fatal("early saturation")
		}
	}
	if s.submit(0, false, func() {}) {
		t.Fatal("unbounded storage queue")
	}
	for i := 0; i < 256; i++ {
		if !s.submit(0, true, func() {}) {
			t.Fatal("cleanup reservation unavailable")
		}
	}
	if s.submit(0, true, func() {}) {
		t.Fatal("unbounded cleanup queue")
	}
}

func TestAsyncArtifactWritesCompleteBeforeResponse(t *testing.T) {
	d := serviceTestDaemon(t)
	d.storage = &storageExecutor{}
	defer d.storage.workers.Wait()
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	d.mu.Lock()
	d.route(agent, newRequest("screenshot.capture_region", object{"delivery": value("artifact")}, nil, 1))
	request := serviceNextMessage(t, extension).object("request")
	id := request.text("id")
	data := []byte("image")
	a := artifactTestDescriptor("a", data)
	a["requestId"] = value(id)
	for _, message := range []object{
		{"type": value("extension.artifact.begin"), "artifact": value(a), "messageId": value("begin")},
		{"type": value("extension.artifact.chunk"), "artifact": value(object{"requestId": value(id)}), "artifactId": a["artifactId"], "chunkIndex": value(0), "data": value(base64.StdEncoding.EncodeToString(data)), "messageId": value("chunk")},
		{"type": value("extension.artifact.commit"), "artifact": value(object{"requestId": value(id)}), "artifactId": a["artifactId"], "messageId": value("commit")},
	} {
		d.artifactMessage(extension, message)
	}
	d.response(extension, success(id, object{"delivery": value("artifact"), "artifact": value(a)}))
	d.mu.Unlock()
	d.storage.workers.Wait()
	if !serviceNextMessage(t, agent).object("response").boolean("ok") {
		t.Fatal("response overtook artifact commit")
	}
	for _, id := range []string{"begin", "chunk", "commit"} {
		ack := serviceNextMessage(t, extension)
		if ack.text("messageId") != id || ack.text("error") != "" {
			t.Fatalf("bad artifact acknowledgement: %s", value(ack))
		}
	}
}

func TestDaemonOperationTimeoutsIncludeCompoundAndDefaultWaits(t *testing.T) {
	for _, tc := range []struct {
		method string
		params object
		want   time.Duration
	}{
		{"webmcp.execute_tool", nil, 82 * time.Second},
		{"webmcp.execute_tool", object{"approvalTimeoutMs": value(60000), "timeoutMs": value(30000)}, 102 * time.Second},
		{"session.export", nil, 102 * time.Second},
		{"session.read", object{"waitMs": value(30000)}, 32 * time.Second},
		{"download.resource", nil, 37 * time.Second},
		{"input.click", object{"holdMs": value("10000"), "clickCount": value("2"), "timeoutMs": value(15000), "observe": value(object{"settleMs": value(5000)})}, 47 * time.Second},
	} {
		if got := daemonOperationTimeout(tc.method, tc.params); got != tc.want {
			t.Errorf("%s: %s, want %s", tc.method, got, tc.want)
		}
	}
}

func TestDaemonCancellationIsOwnerScoped(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	stranger := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	request := newRequest("input.click", nil, nil, 1)
	d.route(agent, request)
	routed := serviceNextMessage(t, extension).object("request")
	original := d.pending[routed.text("id")].original
	d.handle(stranger, object{"type": value("agent.cancel"), "requestId": value(original)})
	if len(d.pending) != 1 {
		t.Fatal("another client canceled the request")
	}
	d.handle(agent, object{"type": value("agent.cancel"), "requestId": value(original)})
	canceled := serviceNextMessage(t, extension)
	if canceled.text("type") != "extension.request_cancelled" || canceled.text("requestId") != routed.text("id") {
		t.Fatal("missing scoped cancellation")
	}
	if serviceNextMessage(t, agent).object("response").object("error").text("code") != "TIMEOUT" {
		t.Fatal("missing canceled response")
	}
}

func TestQueuedMessageKeepsItsEncodedSnapshot(t *testing.T) {
	d := serviceTestDaemon(t)
	p := serviceTestPeer(t, d, "agent")
	message := object{"type": value("before")}
	p.send(message)
	message["type"] = value("after")
	queued := <-p.out
	encoded, err := decodeObject(queued.payload)
	if err != nil || encoded.text("type") != "before" || queued.bytes != int64(len(queued.payload)+1) {
		t.Fatalf("queued frame changed after admission: %s %v", queued.payload, err)
	}
}

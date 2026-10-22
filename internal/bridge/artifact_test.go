package bridge

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func artifactTestDescriptor(seed string, data []byte) object {
	digest := sha256.Sum256(data)
	return object{"artifactId": value("art_" + strings.Repeat(seed, 43)), "kind": value("screenshot"), "mimeType": value("image/png"), "byteLength": value(len(data)), "sha256": value(hex.EncodeToString(digest[:])), "chunkSize": value(artifactChunkBytes), "chunkCount": value((int64(len(data)) + artifactChunkBytes - 1) / artifactChunkBytes), "createdAt": value(time.Now().UTC().Format(time.RFC3339Nano)), "expiresAt": value(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))}
}

func requireServiceCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *serviceError
	if !errors.As(err, &typed) || typed.code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func newArtifactTestStore(t *testing.T) *artifactStore {
	t.Helper()
	s := newArtifactStore(filepath.Join(t.TempDir(), "artifacts"))
	if err := s.reset(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for id := range s.items {
			_ = s.remove(id)
		}
	})
	return s
}

func storeTestArtifact(t *testing.T, s *artifactStore, a object, data []byte, request, owner, extension string) {
	t.Helper()
	if err := s.begin(a, request, owner, extension); err != nil {
		t.Fatal(err)
	}
	for i, offset := int64(0), int64(0); offset < int64(len(data)); i, offset = i+1, offset+artifactChunkBytes {
		end := min(offset+artifactChunkBytes, int64(len(data)))
		if err := s.write(a.text("artifactId"), i, base64.StdEncoding.EncodeToString(data[offset:end])); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.commit(a.text("artifactId")); err != nil {
		t.Fatal(err)
	}
}

func TestArtifactStoreLifecycleAndOwnership(t *testing.T) {
	s := newArtifactTestStore(t)
	data := bytes.Repeat([]byte("bounded chunk\x00"), 17000)
	a := artifactTestDescriptor("a", data)
	id := a.text("artifactId")
	storeTestArtifact(t, s, a, data, "request", "owner", "extension")
	if !s.matches(a, "owner", "request", "screenshot") || s.matches(a, "stranger", "request", "screenshot") || s.matches(a, "owner", "other-request", "screenshot") {
		t.Fatal("descriptor ownership mismatch")
	}
	for _, key := range []string{"sha256", "mimeType", "createdAt", "expiresAt", "byteLength", "chunkCount", "chunkSize"} {
		copy := object{}
		for k, v := range a {
			copy[k] = v
		}
		copy[key] = value("forged")
		if s.matches(copy, "owner", "request", "screenshot") {
			t.Fatalf("accepted forged %s", key)
		}
	}
	_, err := s.read(id, "stranger", 0, 1)
	requireServiceCode(t, err, "ARTIFACT_NOT_FOUND")
	_, err = s.delete(id, "stranger")
	requireServiceCode(t, err, "ARTIFACT_NOT_FOUND")
	var recovered []byte
	for offset := int64(0); ; {
		r, err := s.read(id, "owner", offset, 50000)
		if err != nil {
			t.Fatal(err)
		}
		chunk, err := base64.StdEncoding.DecodeString(r.text("data"))
		if err != nil {
			t.Fatal(err)
		}
		if len(chunk) > 50000 || int64(len(chunk)) != r.number("byteLength") || r.number("offset") != offset {
			t.Fatal("read exceeded requested range")
		}
		recovered = append(recovered, chunk...)
		if string(r["nextOffset"]) == "null" {
			break
		}
		offset = r.number("nextOffset")
	}
	if !bytes.Equal(recovered, data) {
		t.Fatal("artifact readback differs")
	}
	for _, limits := range [][2]int64{{-1, 1}, {0, 0}, {0, artifactChunkBytes + 1}} {
		_, err := s.read(id, "owner", limits[0], limits[1])
		requireServiceCode(t, err, "INVALID_REQUEST")
	}
	atEnd, err := s.read(id, "owner", int64(len(data))+100, 10)
	if err != nil || atEnd.number("byteLength") != 0 || atEnd.number("offset") != int64(len(data)) {
		t.Fatalf("EOF clamp: %v %v", atEnd, err)
	}
	if result, err := s.delete(id, "owner"); err != nil || !result.boolean("deleted") {
		t.Fatalf("delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.root, id+".bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted artifact remains: %v", err)
	}
}

func TestArtifactStoreTransferValidationQuotasAndExpiry(t *testing.T) {
	s := newArtifactTestStore(t)
	a := artifactTestDescriptor("b", []byte("payload"))
	id := a.text("artifactId")
	if err := s.begin(a, "request", "owner", "extension"); err != nil {
		t.Fatal(err)
	}
	requireServiceCode(t, s.begin(a, "other", "owner", "extension"), "ARTIFACT_TRANSFER_INVALID")
	requireServiceCode(t, s.write(id, 1, "YQ=="), "ARTIFACT_TRANSFER_INVALID")
	requireServiceCode(t, s.write(id, 0, "YR=="), "ARTIFACT_TRANSFER_INVALID")
	requireServiceCode(t, s.write(id, 0, "YQ==\n"), "ARTIFACT_TRANSFER_INVALID")
	requireServiceCode(t, s.commit(id), "ARTIFACT_TRANSFER_INVALID")
	if _, err := os.Stat(filepath.Join(s.root, id+".part")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid commit left partial file")
	}
	for i := 0; i < 16; i++ {
		a := artifactTestDescriptor(string(rune('a'+i)), []byte("x"))
		if err := s.begin(a, "request", "owner", "extension"); err != nil {
			t.Fatal(err)
		}
	}
	requireServiceCode(t, s.begin(artifactTestDescriptor("z", []byte("x")), "request", "owner", "extension"), "ARTIFACT_QUOTA_EXCEEDED")
	s.cleanup("request", "", "", false)
	if len(s.items) != 0 {
		t.Fatal("request cleanup leaked transfers")
	}
	storeTestArtifact(t, s, a, []byte("payload"), "r", "owner", "extension")
	now := time.Now().Add(2 * time.Minute)
	s.now = func() time.Time { return now }
	_, err := s.read(id, "owner", 0, 1)
	requireServiceCode(t, err, "ARTIFACT_NOT_FOUND")
	entries, err := os.ReadDir(s.root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("expired artifacts left on disk: %v", err)
	}
}

func TestArtifactStoreTruncationEmptyResourceAndOwnerCleanup(t *testing.T) {
	s := newArtifactTestStore(t)
	a := artifactTestDescriptor("c", []byte("abc"))
	id := a.text("artifactId")
	storeTestArtifact(t, s, a, []byte("abc"), "r", "owner", "extension")
	if err := os.Truncate(filepath.Join(s.root, id+".bin"), 1); err != nil {
		t.Fatal(err)
	}
	_, err := s.read(id, "owner", 0, 3)
	requireServiceCode(t, err, "ARTIFACT_TRANSFER_INVALID")
	s.cleanup("", "owner", "", false)
	if len(s.items) != 0 {
		t.Fatal("owner cleanup retained artifact")
	}
	a = artifactTestDescriptor("e", nil)
	a["kind"], a["mimeType"] = value("resource"), value("application/octet-stream")
	storeTestArtifact(t, s, a, nil, "empty", "owner", "extension")
	if !s.matches(a, "owner", "empty", "resource") {
		t.Fatal("empty resource was not committed")
	}
	s.cleanup("empty", "", "", true)
	if len(s.items) != 1 {
		t.Fatal("successful completion removed committed artifact")
	}
	s.cleanup("", "", "extension", false)
	if len(s.items) != 0 {
		t.Fatal("extension cleanup retained artifact")
	}
}

func serviceTestDaemon(t *testing.T) *daemon {
	t.Helper()
	d := &daemon{config: config{home: t.TempDir()}, peers: make(map[*peer]bool), pending: make(map[string]*pendingRequest), started: time.Now()}
	d.initServices()
	if err := d.artifacts.reset(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		for _, pending := range d.pending {
			pending.timer.Stop()
		}
		for _, pending := range d.windowActions {
			pending.timer.Stop()
		}
		for id := range d.artifacts.items {
			_ = d.artifacts.remove(id)
		}
	})
	return d
}

func serviceTestPeer(t *testing.T, d *daemon, role string) *peer {
	t.Helper()
	conn, other := net.Pipe()
	t.Cleanup(func() { conn.Close(); other.Close() })
	p := &peer{conn: conn, out: make(chan queuedMessage, 32), done: make(chan struct{}), role: role, id: uniqueID(), owner: uniqueID(), identity: object{}, dataTargets: make(map[*peer]bool), access: true}
	d.peers[p] = true
	return p
}

func serviceNextMessage(t *testing.T, p *peer) object {
	t.Helper()
	select {
	case item := <-p.out:
		p.queuedBytes.Add(-item.bytes)
		return item.message
	default:
		t.Fatal("expected peer message")
		return nil
	}
}

func TestArtifactDaemonRoutingAndForgedTransfers(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	other := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	for _, p := range []*peer{agent, other} {
		request := newRequest("screenshot.capture_region", object{"delivery": value("artifact")}, object{"transport_owner": value("forged-owner")}, 0)
		request["id"] = value("same-id")
		d.route(p, request)
	}
	first := serviceNextMessage(t, extension).object("request")
	second := serviceNextMessage(t, extension).object("request")
	if first.text("id") == second.text("id") || first.object("meta").text("transport_owner") != agent.owner || second.object("meta").text("transport_owner") != other.owner {
		t.Fatal("request IDs or owner metadata were not isolated")
	}
	data := []byte("daemon-owned artifact")
	a := artifactTestDescriptor("r", data)
	a["requestId"] = first["id"]
	d.handle(extension, object{"type": value("extension.artifact.begin"), "artifact": value(a)})
	d.handle(extension, object{"type": value("extension.artifact.chunk"), "artifact": value(object{"requestId": first["id"]}), "artifactId": a["artifactId"], "chunkIndex": value(0), "data": value(base64.StdEncoding.EncodeToString(data))})
	d.handle(extension, object{"type": value("extension.artifact.commit"), "artifact": value(object{"requestId": first["id"]}), "artifactId": a["artifactId"]})
	// A second in-flight request cannot steal the committed descriptor.
	d.response(extension, success(second.text("id"), object{"delivery": value("artifact"), "artifact": value(a)}))
	stolen := serviceNextMessage(t, other).object("response")
	if stolen.boolean("ok") || stolen.object("error").text("code") != "ARTIFACT_TRANSFER_INVALID" {
		t.Fatal("foreign request accepted artifact")
	}
	d.response(extension, success(first.text("id"), object{"delivery": value("artifact"), "artifact": value(a)}))
	response := serviceNextMessage(t, agent).object("response")
	if !response.boolean("ok") || response.text("id") != "same-id" || response.object("meta").text("method") != "screenshot.capture_region" {
		t.Fatalf("artifact response: %s", value(response))
	}
	d.route(other, newRequest("artifact.read", object{"artifactId": a["artifactId"]}, nil, 0))
	if serviceNextMessage(t, other).object("response").object("error").text("code") != "ARTIFACT_NOT_FOUND" {
		t.Fatal("foreign client read artifact")
	}
	d.disconnect(agent)
	if len(d.artifacts.items) != 0 {
		t.Fatal("disconnect retained owned artifact")
	}
	if serviceNextMessage(t, extension).text("type") != "extension.owner_disconnected" {
		t.Fatal("owner disconnect was not relayed")
	}
}

func serviceWirePeer(t *testing.T, d *daemon, role string) (*wireWriter, *bufio.Reader) {
	t.Helper()
	server, connection := net.Pipe()
	p := &peer{conn: server, out: make(chan queuedMessage, 32), done: make(chan struct{}), identity: object{}, owner: uniqueID(), dataTargets: make(map[*peer]bool)}
	d.mu.Lock()
	d.peers[p] = true
	d.mu.Unlock()
	finished := make(chan struct{})
	go func() { defer close(finished); d.serve(p) }()
	t.Cleanup(func() { connection.Close(); server.Close(); <-finished })
	if err := connection.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	w := &wireWriter{out: connection}
	token := d.agentToken
	if role == "extension" {
		token = d.extensionToken
	}
	if err := w.send(object{"type": value("register"), "role": value(role), "clientId": value(uniqueID()), "authToken": value(token)}); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(connection)
	ack, err := readLine(r)
	if err != nil || ack.text("type") != "registered" {
		t.Fatalf("registration: %s %v", value(ack), err)
	}
	return w, r
}

func TestArtifactDaemonWireRoundTrip(t *testing.T) {
	d := serviceTestDaemon(t)
	d.agentToken, d.extensionToken = strings.Repeat("a", 43), strings.Repeat("e", 43)
	extensionWriter, extensionReader := serviceWirePeer(t, d, "extension")
	agentWriter, agentReader := serviceWirePeer(t, d, "agent")
	request := newRequest("screenshot.capture_region", object{"delivery": value("artifact")}, nil, 0)
	if err := agentWriter.send(object{"type": value("agent.request"), "request": value(request)}); err != nil {
		t.Fatal(err)
	}
	forwarded, err := readLine(extensionReader)
	if err != nil {
		t.Fatal(err)
	}
	routed := forwarded.object("request")
	data := []byte("real framed daemon transfer")
	a := artifactTestDescriptor("w", data)
	a["requestId"] = routed["id"]
	for _, message := range []object{
		{"type": value("extension.artifact.begin"), "artifact": value(a)},
		{"type": value("extension.artifact.chunk"), "artifact": value(object{"requestId": routed["id"]}), "artifactId": a["artifactId"], "chunkIndex": value(0), "data": value(base64.StdEncoding.EncodeToString(data))},
		{"type": value("extension.artifact.commit"), "artifact": value(object{"requestId": routed["id"]}), "artifactId": a["artifactId"]},
		{"type": value("extension.response"), "response": value(success(routed.text("id"), object{"delivery": value("artifact"), "artifact": value(a)}))},
	} {
		if err := extensionWriter.send(message); err != nil {
			t.Fatal(err)
		}
	}
	response, err := readLine(agentReader)
	if err != nil || !response.object("response").boolean("ok") || response.object("response").text("id") != request.text("id") {
		t.Fatalf("artifact response: %s %v", value(response), err)
	}
	if err := agentWriter.send(object{"type": value("agent.request"), "request": value(newRequest("artifact.read", object{"artifactId": a["artifactId"]}, nil, 0))}); err != nil {
		t.Fatal(err)
	}
	response, err = readLine(agentReader)
	if err != nil || response.object("response").object("result").text("data") != base64.StdEncoding.EncodeToString(data) {
		t.Fatalf("artifact read: %s %v", value(response), err)
	}
}

package bridge

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRecordingStoreDurableRestartAndWriterOwnership(t *testing.T) {
	root := filepath.Join(t.TempDir(), "recordings")
	s := newRecordingStore(root)
	created, err := s.begin("extension-a")
	if err != nil {
		t.Fatal(err)
	}
	id := created.text("journalId")
	text := "{\"kind\":\"event\",\"event\":{\"type\":\"click\",\"at\":1}}\n{\"kind\":"
	data := base64.StdEncoding.EncodeToString([]byte(text))
	_, err = s.append(id, "extension-b", 0, data)
	requireServiceCode(t, err, "ACCESS_DENIED")
	r, err := s.append(id, "extension-a", 0, data)
	if err != nil || r.number("nextOffset") != int64(len(text)) {
		t.Fatalf("append: %s %v", value(r), err)
	}
	_, err = s.append(id, "extension-a", 0, data)
	requireServiceCode(t, err, "INVALID_REQUEST")
	s.disconnect("extension-a")
	_, err = s.append(id, "extension-a", int64(len(text)), data)
	requireServiceCode(t, err, "ACCESS_DENIED")
	restarted := newRecordingStore(root)
	_, err = restarted.append(id, "extension-a", int64(len(text)), data)
	requireServiceCode(t, err, "ACCESS_DENIED")
	var recovered []byte
	for offset := int64(0); ; {
		r, err := restarted.read(id, offset, 8)
		if err != nil {
			t.Fatal(err)
		}
		b, err := base64.StdEncoding.DecodeString(r.text("data"))
		if err != nil {
			t.Fatal(err)
		}
		recovered = append(recovered, b...)
		if string(r["nextOffset"]) == "null" {
			break
		}
		offset = r.number("nextOffset")
	}
	if string(recovered) != text {
		t.Fatalf("durable partial tail changed: %q", recovered)
	}
	for _, bounds := range [][2]int64{{-1, 1}, {int64(len(text)) + 1, 1}, {0, 0}, {0, artifactChunkBytes + 1}} {
		_, err := restarted.read(id, bounds[0], bounds[1])
		requireServiceCode(t, err, "INVALID_REQUEST")
	}
	_, err = restarted.read("../outside", 0, 1)
	requireServiceCode(t, err, "ARTIFACT_NOT_FOUND")
	if result, err := restarted.delete(id); err != nil || !result.boolean("deleted") {
		t.Fatalf("delete: %v", err)
	}
	if _, err := restarted.read(id, 0, 1); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted journal still readable: %v", err)
	}
}

func TestRecordingStoreExpirySymlinksAndQuotas(t *testing.T) {
	s := newRecordingStore(filepath.Join(t.TempDir(), "recordings"))
	r, err := s.begin("extension")
	if err != nil {
		t.Fatal(err)
	}
	id := r.text("journalId")
	path, _ := s.filename(id)
	if err := os.Chtimes(path, time.Unix(0, 0), time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.read(id, 0, 1); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired journal still readable: %v", err)
	}
	if _, exists := s.writers[id]; exists {
		t.Fatal("expired journal retained write authority")
	}
	if runtime.GOOS != "windows" {
		secret := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(secret, []byte("private"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(secret, path); err != nil {
			t.Fatal(err)
		}
		if _, err := s.read(id, 0, 10); err == nil {
			t.Fatal("symlink journal was readable")
		}
		s.writers[id] = "extension"
		if _, err := s.append(id, "extension", 7, base64.StdEncoding.EncodeToString([]byte("!"))); err == nil {
			t.Fatal("symlink journal was writable")
		}
		b, _ := os.ReadFile(secret)
		if string(b) != "private" {
			t.Fatal("symlink target modified")
		}
		if _, err := s.delete(id); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 32; i++ {
		if _, err := s.begin("extension"); err != nil {
			t.Fatal(err)
		}
	}
	_, err = s.begin("extension")
	requireServiceCode(t, err, "ARTIFACT_QUOTA_EXCEEDED")
}

func TestRecordingDaemonRequiresPendingStartAndRevokesWriter(t *testing.T) {
	d := serviceTestDaemon(t)
	agent := serviceTestPeer(t, d, "agent")
	extension := serviceTestPeer(t, d, "extension")
	foreign := serviceTestPeer(t, d, "extension")
	request := newRequest("session.start", object{}, object{"target_extension": value(extension.id)}, 0)
	d.route(agent, request)
	forwarded := serviceNextMessage(t, extension).object("request")
	begin := object{"type": value("extension.journal.begin"), "requestId": forwarded["id"], "messageId": value("begin")}
	d.handle(foreign, begin)
	if serviceNextMessage(t, foreign).text("error") == "" {
		t.Fatal("foreign extension created journal")
	}
	d.handle(extension, begin)
	created := serviceNextMessage(t, extension).object("result")
	id := created.text("journalId")
	if !recordingIDPattern.MatchString(id) {
		t.Fatal("missing journal acknowledgement")
	}
	d.response(extension, success(forwarded.text("id"), object{"journalId": value(id)}))
	_ = serviceNextMessage(t, agent)
	appendMessage := object{"type": value("extension.journal.append"), "messageId": value("append"), "journalId": value(id), "offset": value(0), "data": value("YQ==")}
	d.handle(extension, appendMessage)
	if serviceNextMessage(t, extension).object("result").number("nextOffset") != 1 {
		t.Fatal("journal append failed")
	}
	d.handle(extension, object{"type": value("extension.access_update"), "accessEnabled": value(false)})
	d.handle(extension, appendMessage)
	if serviceNextMessage(t, extension).text("error") == "" {
		t.Fatal("revoked writer could append")
	}
	d.route(agent, newRequest("session.journal_read", object{"journalId": value(id)}, nil, 0))
	if result := serviceNextMessage(t, agent).object("response"); !result.boolean("ok") || result.object("result").text("data") != "YQ==" {
		t.Fatalf("journal unreadable after revocation: %s", value(result))
	}
}

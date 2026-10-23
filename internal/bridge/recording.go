package bridge

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const recordingMaxBytes int64 = 128 * 1024 * 1024
const recordingTotalBytes int64 = 256 * 1024 * 1024
const recordingTTL = 24 * time.Hour

var recordingIDPattern = regexp.MustCompile(`^journal_[a-f0-9]{64}$`)

type recordingStore struct {
	root    string
	writers map[string]string
	now     func() time.Time
}

func newRecordingStore(root string) *recordingStore {
	return &recordingStore{root: root, writers: make(map[string]string), now: time.Now}
}

func (s *recordingStore) filename(id string) (string, error) {
	if !recordingIDPattern.MatchString(id) {
		return "", serviceFailure("ARTIFACT_NOT_FOUND", "Unknown recording journal.")
	}
	return filepath.Join(s.root, id+".jsonl"), nil
}

// Verify both the directory entry and the opened file before any read/write.
// This rejects symlinks and replacement races on every supported platform.
func openRegularFile(path string, flag int) (*os.File, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() {
		return nil, errors.New("journal/artifact is not a regular file")
	}
	f, err := os.OpenFile(path, flag, 0)
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		_ = f.Close()
		return nil, errors.New("journal/artifact file changed while opening")
	}
	return f, nil
}

func (s *recordingStore) prune() (int64, int, error) {
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return 0, 0, err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return 0, 0, err
	}
	var size int64
	count := len(entries)
	for _, e := range entries {
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		if !strings.HasSuffix(e.Name(), ".jsonl") || !recordingIDPattern.MatchString(id) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return 0, 0, err
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if s.now().Sub(info.ModTime()) > recordingTTL {
			if err := os.Remove(filepath.Join(s.root, e.Name())); err != nil {
				return 0, 0, err
			}
			delete(s.writers, id)
			count--
		} else {
			size += info.Size()
		}
	}
	return size, count, nil
}

func (s *recordingStore) begin(extension string) (object, error) {
	used, count, err := s.prune()
	if err != nil {
		return nil, err
	}
	if used >= recordingTotalBytes || count >= 32 {
		return nil, serviceFailure("ARTIFACT_QUOTA_EXCEEDED", "Recording journal quota exceeded. Delete old journals.")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	id := "journal_" + hex.EncodeToString(random[:])
	path, _ := s.filename(id)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	err = f.Sync()
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	s.writers[id] = extension
	return object{"journalId": value(id), "nextOffset": value(0), "expiresAt": value(s.now().Add(recordingTTL).UTC().Format(time.RFC3339Nano))}, nil
}

func (s *recordingStore) append(id, extension string, offset int64, data string) (object, error) {
	if s.writers[id] != extension || extension == "" {
		return nil, serviceFailure("ACCESS_DENIED", "Journal writer connection does not match.")
	}
	if offset < 0 || offset > 9007199254740991 || len(data) > 262144 {
		return nil, serviceFailure("INVALID_REQUEST", "Invalid journal chunk.")
	}
	b, err := base64.StdEncoding.Strict().DecodeString(data)
	if err != nil || base64.StdEncoding.EncodeToString(b) != data {
		return nil, serviceFailure("INVALID_REQUEST", "Invalid journal chunk.")
	}
	used, _, err := s.prune()
	if err != nil {
		return nil, err
	}
	if used+int64(len(b)) > recordingTotalBytes || offset+int64(len(b)) > recordingMaxBytes {
		return nil, serviceFailure("ARTIFACT_QUOTA_EXCEEDED", "Recording journal byte quota exceeded.")
	}
	path, err := s.filename(id)
	if err != nil {
		return nil, err
	}
	f, err := openRegularFile(path, os.O_WRONLY)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if stat.Size() != offset {
		return nil, serviceFailure("INVALID_REQUEST", "Journal offset mismatch.")
	}
	if _, err := f.WriteAt(b, offset); err != nil {
		return nil, err
	}
	if err := f.Sync(); err != nil {
		return nil, err
	}
	return object{"journalId": value(id), "nextOffset": value(offset + int64(len(b)))}, nil
}

func (s *recordingStore) read(id string, offset, limit int64) (object, error) {
	if _, _, err := s.prune(); err != nil {
		return nil, err
	}
	path, err := s.filename(id)
	if err != nil {
		return nil, err
	}
	f, err := openRegularFile(path, os.O_RDONLY)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if offset < 0 || offset > stat.Size() || limit < 1 || limit > artifactChunkBytes {
		return nil, serviceFailure("INVALID_REQUEST", "Invalid journal read range.")
	}
	count := min(limit, stat.Size()-offset)
	b := make([]byte, int(count))
	n, err := f.ReadAt(b, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	next := value[*int64](nil)
	if offset+int64(n) < stat.Size() {
		next = value(offset + int64(n))
	}
	return object{"journalId": value(id), "offset": value(offset), "byteLength": value(n), "totalBytes": value(stat.Size()), "nextOffset": next, "data": value(base64.StdEncoding.EncodeToString(b[:n]))}, nil
}

func (s *recordingStore) delete(id string) (object, error) {
	path, err := s.filename(id)
	if err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil {
		return nil, err
	}
	delete(s.writers, id)
	return object{"deleted": value(true)}, nil
}

func (s *recordingStore) disconnect(extension string) {
	for id, owner := range s.writers {
		if owner == extension {
			delete(s.writers, id)
		}
	}
}

func (d *daemon) journalMessage(p *peer, m object) {
	var result object
	var err error
	if m.text("type") == "extension.journal.begin" {
		pending := d.pending[m.text("requestId")]
		if pending == nil || pending.method != "session.start" || pending.target != p {
			err = errors.New("Journal must be created by a pending session.start request.")
		} else {
			result, err = d.recordings.begin(p.id)
		}
	} else if offset, valid := serviceInteger(m, "offset"); valid {
		var data string
		if json.Unmarshal(m["data"], &data) != nil || string(m["data"]) == "null" {
			err = errors.New("Invalid journal chunk.")
		} else {
			result, err = d.recordings.append(m.text("journalId"), p.id, offset, data)
		}
	} else {
		err = errors.New("Invalid journal chunk.")
	}
	ack := object{"type": value("extension.journal.ack"), "messageId": m["messageId"]}
	if err != nil {
		ack["error"] = value(err.Error())
	} else {
		ack["result"] = value(result)
	}
	p.send(ack)
}

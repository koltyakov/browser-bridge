package bridge

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

const artifactChunkBytes int64 = protocol.ArtifactChunkBytes
const artifactMaxBytes int64 = protocol.MaxArtifactBytes
const artifactClientBytes int64 = protocol.MaxArtifactClientBytes
const artifactTotalBytes int64 = protocol.MaxArtifactTotalBytes
const artifactTTL = protocol.ArtifactTTLMS * time.Millisecond

var artifactIDPattern = regexp.MustCompile(`^art_[A-Za-z0-9_-]{32,64}$`)
var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var artifactMIMEPattern = regexp.MustCompile(`^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$`)

type serviceError struct{ code, message string }

func (e *serviceError) Error() string           { return e.message }
func serviceFailure(code, message string) error { return &serviceError{code, message} }
func serviceResponse(id string, result object, err error, fallback string) object {
	if err == nil {
		return success(id, result)
	}
	var typed *serviceError
	if errors.As(err, &typed) {
		return failure(id, typed.code, typed.message)
	}
	return failure(id, fallback, err.Error())
}

// Read integer JSON values strictly; missing, fractional, quoted, and unsafe
// values must not quietly become zero in byte offsets or transfer metadata.
func serviceInteger(o object, key string) (int64, bool) {
	var n float64
	if len(o[key]) == 0 || string(o[key]) == "null" || json.Unmarshal(o[key], &n) != nil {
		return 0, false
	}
	if n < -9007199254740991 || n > 9007199254740991 || math.Trunc(n) != n {
		return 0, false
	}
	return int64(n), true
}

// Match the protocol's clampInt behavior for artifact/log read budgets.
func serviceClampInt(o object, key string, low, high, fallback int64) int64 {
	n, ok := serviceNumber(o, key)
	if !ok {
		if o.boolean(key) {
			n, ok = 1, true
		} else if text := strings.TrimSpace(o.text(key)); text != "" {
			var err error
			n, err = strconv.ParseFloat(text, 64)
			ok = err == nil
		}
	}
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n == 0 {
		return fallback
	}
	return int64(math.Min(float64(high), math.Max(float64(low), math.Trunc(n))))
}

type artifactRecord struct {
	descriptor                  protocol.ArtifactDescriptor
	request, owner, extension   string
	size, chunks, written, next int64
	expires                     time.Time
	path                        string
	file                        *os.File
	hash                        hash.Hash
}

// The daemon lock protects all store operations. Incomplete and committed
// artifacts share quota accounting so parallel transfers cannot over-reserve.
type artifactStore struct {
	root  string
	items map[string]*artifactRecord
	now   func() time.Time
}

func newArtifactStore(root string) *artifactStore {
	return &artifactStore{root: root, items: make(map[string]*artifactRecord), now: time.Now}
}

func (s *artifactStore) reset() error {
	for id := range s.items {
		_ = s.remove(id)
	}
	if err := os.RemoveAll(s.root); err != nil {
		return err
	}
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return err
	}
	return os.Chmod(s.root, 0700)
}

func (s *artifactStore) begin(a object, request, owner, extension string) error {
	s.prune()
	id, kind, mime := a.text("artifactId"), a.text("kind"), a.text("mimeType")
	size, sizeOK := serviceInteger(a, "byteLength")
	chunks, chunksOK := serviceInteger(a, "chunkCount")
	created, createdErr := time.Parse(time.RFC3339Nano, a.text("createdAt"))
	expires, expiresErr := time.Parse(time.RFC3339Nano, a.text("expiresAt"))
	now := s.now()
	mimeOK := (kind == "screenshot" && strings.HasPrefix(mime, "image/")) || (kind == "har" && mime == "application/json") || (kind == "resource" && len(mime) <= 120 && artifactMIMEPattern.MatchString(mime))
	if !artifactIDPattern.MatchString(id) || !sizeOK || !chunksOK || size < 0 || (kind != "resource" && size == 0) || size > artifactMaxBytes || chunks != (size+artifactChunkBytes-1)/artifactChunkBytes || !digestPattern.MatchString(a.text("sha256")) || !mimeOK || createdErr != nil || expiresErr != nil || created.After(now.Add(10*time.Second)) || created.Before(now.Add(-artifactTTL)) || !expires.After(now) || !expires.After(created) || expires.After(now.Add(artifactTTL)) || s.items[id] != nil {
		return serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact identifier, size, or metadata is invalid.")
	}
	var ownedBytes, totalBytes int64
	ownedCount := 0
	for _, item := range s.items {
		totalBytes += item.size
		if item.owner == owner {
			ownedBytes += item.size
			ownedCount++
		}
	}
	if ownedCount >= protocol.MaxArtifactsPerClient || ownedBytes+size > artifactClientBytes || totalBytes+size > artifactTotalBytes {
		return serviceFailure("ARTIFACT_QUOTA_EXCEEDED", "Artifact quota exceeded.")
	}
	path := filepath.Join(s.root, id+".part")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	descriptor := protocol.ArtifactDescriptor{ArtifactId: id, Kind: protocol.ArtifactKind(kind), MimeType: mime, ByteLength: float64(size), SHA256: a.text("sha256"), ChunkSize: float64(artifactChunkBytes), ChunkCount: float64(chunks), CreatedAt: a.text("createdAt"), ExpiresAt: a.text("expiresAt")}
	s.items[id] = &artifactRecord{descriptor: descriptor, request: request, owner: owner, extension: extension, size: size, chunks: chunks, expires: expires, path: path, file: file, hash: sha256.New()}
	return nil
}

func (s *artifactStore) write(id string, index int64, data string) error {
	r := s.items[id]
	if r == nil || r.file == nil || index != r.next || len(data) > int((artifactChunkBytes+2)/3*4) {
		return serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact chunk order or size is invalid.")
	}
	b, err := base64.StdEncoding.Strict().DecodeString(data)
	if err != nil || base64.StdEncoding.EncodeToString(b) != data || len(b) == 0 || int64(len(b)) > artifactChunkBytes || r.written+int64(len(b)) > r.size {
		return serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact chunk is not canonical base64 or exceeds its declared size.")
	}
	if _, err := r.file.Write(b); err != nil {
		_ = s.remove(id)
		return err
	}
	_, _ = r.hash.Write(b)
	r.written += int64(len(b))
	r.next++
	return nil
}

func (s *artifactStore) commit(id string) error {
	r := s.items[id]
	if r == nil || r.file == nil {
		return serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact transfer is missing.")
	}
	if r.written != r.size || r.next != r.chunks || hex.EncodeToString(r.hash.Sum(nil)) != r.descriptor.SHA256 {
		_ = s.remove(id)
		return serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact checksum is invalid.")
	}
	if err := r.file.Close(); err != nil {
		_ = s.remove(id)
		return err
	}
	r.file = nil
	final := filepath.Join(s.root, id+".bin")
	if err := os.Rename(r.path, final); err != nil {
		_ = s.remove(id)
		return err
	}
	r.path, r.hash = final, nil
	return nil
}

func (s *artifactStore) owned(id, owner string) (*artifactRecord, error) {
	s.prune()
	r := s.items[id]
	if r == nil || r.file != nil || r.owner != owner {
		return nil, serviceFailure("ARTIFACT_NOT_FOUND", "Artifact was not found.")
	}
	return r, nil
}

func (s *artifactStore) read(id, owner string, offset, limit int64) (object, error) {
	r, err := s.owned(id, owner)
	if err != nil {
		return nil, err
	}
	if offset < 0 || offset > 9007199254740991 || limit < 1 || limit > artifactChunkBytes {
		return nil, serviceFailure("INVALID_REQUEST", "Invalid artifact read range.")
	}
	if offset > r.size {
		offset = r.size
	}
	count := min(limit, r.size-offset)
	f, err := openRegularFile(r.path, os.O_RDONLY)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	b := make([]byte, int(count))
	if _, err := io.ReadFull(io.NewSectionReader(f, offset, count), b); err != nil {
		return nil, serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact was truncated on disk.")
	}
	next := value[*int64](nil)
	if offset+count < r.size {
		next = value(offset + count)
	}
	return object{"artifactId": value(id), "data": value(base64.StdEncoding.EncodeToString(b)), "offset": value(offset), "byteLength": value(count), "chunkIndex": value(offset / artifactChunkBytes), "chunkCount": value(r.chunks), "nextOffset": next, "totalBytes": value(r.size), "sha256": value(r.descriptor.SHA256), "expiresAt": value(r.descriptor.ExpiresAt)}, nil
}

func (s *artifactStore) delete(id, owner string) (object, error) {
	if _, err := s.owned(id, owner); err != nil {
		return nil, err
	}
	if err := s.remove(id); err != nil {
		return nil, err
	}
	return object{"artifactId": value(id), "deleted": value(true)}, nil
}

func (s *artifactStore) matches(a object, owner, request, kind string) bool {
	r, err := s.owned(a.text("artifactId"), owner)
	if err != nil || r.request != request || kind == "" || string(r.descriptor.Kind) != kind {
		return false
	}
	want, _ := decodeObject(value(r.descriptor))
	for _, key := range []string{"artifactId", "kind", "mimeType", "sha256", "createdAt", "expiresAt"} {
		if a.text(key) != want.text(key) {
			return false
		}
	}
	for _, key := range []string{"byteLength", "chunkSize", "chunkCount"} {
		n, ok := serviceInteger(a, key)
		if !ok || n != want.number(key) {
			return false
		}
	}
	return true
}

func (s *artifactStore) remove(id string) error {
	r := s.items[id]
	if r == nil {
		return nil
	}
	if r.file != nil {
		_ = r.file.Close()
	}
	delete(s.items, id)
	err := os.Remove(r.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *artifactStore) prune() {
	for id, r := range s.items {
		if !r.expires.After(s.now()) {
			_ = s.remove(id)
		}
	}
}

func (s *artifactStore) cleanup(request, owner, extension string, preserve bool) {
	for id, r := range s.items {
		if (request != "" && r.request == request && (!preserve || r.file != nil)) || (owner != "" && r.owner == owner) || (extension != "" && r.extension == extension) {
			_ = s.remove(id)
		}
	}
}

func artifactKind(method string) string {
	if isVisualBaseline(method) {
		return ""
	}
	if strings.HasPrefix(method, "screenshot.") {
		return "screenshot"
	}
	if method == "network.export_har" {
		return "har"
	}
	if method == "download.resource" || method == "session.export" {
		return "resource"
	}
	return ""
}

func (d *daemon) artifactMessage(p *peer, message object) {
	a := message.object("artifact")
	requestID := a.text("requestId")
	pending := d.pending[requestID]
	if pending == nil || pending.target != p || pending.owner.role != "agent" {
		d.artifactAck(p, message, errors.New("Artifact request is no longer active."))
		return
	}
	var barrier chan struct{}
	if d.storage != nil && !validID(message.text("messageId")) {
		// Legacy extensions enqueue all chunks without acknowledgements. Slow
		// only this connection's reads, never daemon routing, until its write
		// settles so a valid large transfer cannot overflow the storage queue.
		barrier = make(chan struct{})
		p.legacyArtifactBarrier = barrier
	}
	if !d.store(len(value(message)), false, func() func() {
		err := d.writeArtifactMessage(p, pending, message)
		return func() {
			if barrier != nil {
				defer close(barrier)
			}
			if err != nil && d.pending[requestID] == pending && pending.localError == nil {
				pending.localError = serviceResponse(requestID, nil, err, "ARTIFACT_TRANSFER_INVALID")
			}
			d.artifactAck(p, message, err)
		}
	}) {
		if barrier != nil {
			close(barrier)
		}
		err := serviceFailure("ARTIFACT_QUOTA_EXCEEDED", "Artifact storage queue capacity reached.")
		pending.localError = serviceResponse(requestID, nil, err, "ARTIFACT_TRANSFER_INVALID")
		d.artifactAck(p, message, err)
	}
}

func (d *daemon) artifactAck(p *peer, message object, err error) {
	if !validID(message.text("messageId")) {
		return
	}
	ack := object{"type": value("extension.artifact.ack"), "messageId": message["messageId"]}
	if err != nil {
		ack["error"] = value(err.Error())
	}
	p.send(ack)
}

func (d *daemon) writeArtifactMessage(p *peer, pending *pendingRequest, message object) error {
	a := message.object("artifact")
	requestID := a.text("requestId")
	var err error
	id := message.text("artifactId")
	switch message.text("type") {
	case "extension.artifact.begin":
		if a.text("kind") != artifactKind(pending.method) || artifactKind(pending.method) == "" {
			err = serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact kind does not match the routed operation.")
		} else {
			err = d.artifacts.begin(a, requestID, pending.owner.owner, p.id)
		}
	case "extension.artifact.chunk", "extension.artifact.commit":
		r := d.artifacts.items[id]
		if r == nil || r.file == nil || r.request != requestID || r.owner != pending.owner.owner || r.extension != p.id {
			err = serviceFailure("ARTIFACT_TRANSFER_INVALID", "Artifact transfer does not belong to this request and extension.")
			break
		}
		if message.text("type") == "extension.artifact.commit" {
			err = d.artifacts.commit(id)
		} else if index, ok := serviceInteger(message, "chunkIndex"); ok {
			err = d.artifacts.write(id, index, message.text("data"))
		} else {
			err = serviceFailure("ARTIFACT_TRANSFER_INVALID", "Invalid artifact chunk index.")
		}
	}
	return err
}

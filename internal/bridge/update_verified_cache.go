package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// updateVerifiedRecord remembers a payload whose digest matched, keyed by
// what changes when the file is replaced, so later invocations skip the
// SHA-256 pass over the whole binary.
type updateVerifiedRecord struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	SHA256  string `json:"sha256"`
}

func updateVerifiedCachePath(root string) string {
	return filepath.Join(root, "verified.json")
}

// updateVerifiedCacheHit reports whether path is the same file, unchanged,
// that last passed verification against record's digest.
func updateVerifiedCacheHit(root, path string, record updateInstalled) bool {
	data, err := os.ReadFile(updateVerifiedCachePath(root))
	if err != nil {
		return false
	}
	var cached updateVerifiedRecord
	if json.Unmarshal(data, &cached) != nil {
		return false
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return cached.Path == path && cached.SHA256 == record.SHA256 && cached.Size == record.Size &&
		info.Size() == cached.Size && info.ModTime().UnixNano() == cached.ModTime
}

// updateRememberVerified records a successful verification. Failure to write
// only means the next invocation hashes again.
func updateRememberVerified(root, path string, record updateInstalled) {
	info, err := os.Lstat(path)
	if err != nil {
		return
	}
	data, err := json.Marshal(updateVerifiedRecord{Path: path, Size: info.Size(), ModTime: info.ModTime().UnixNano(), SHA256: record.SHA256})
	if err != nil {
		return
	}
	temp := updateVerifiedCachePath(root) + ".tmp"
	if os.WriteFile(temp, data, 0o600) == nil {
		_ = os.Rename(temp, updateVerifiedCachePath(root))
	}
}

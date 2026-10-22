package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type updateInstalled struct {
	Instance       string `json:"instance"`
	Version        string `json:"version"`
	Target         string `json:"target"`
	SHA256         string `json:"sha256"`
	Size           int64  `json:"size"`
	ManifestDigest string `json:"manifestDigest"`
}

var updateInstancePattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type updateState struct {
	SchemaVersion   int              `json:"schemaVersion"`
	RollbackFrom    string           `json:"rollbackFrom,omitempty"`
	Current         *updateInstalled `json:"current,omitempty"`
	Previous        *updateInstalled `json:"previous,omitempty"`
	BlockedVersions []string         `json:"blockedVersions,omitempty"`
	HighestSequence uint64           `json:"highestSequence"`
	HighestDigest   string           `json:"highestDigest,omitempty"`
	LastCheck       time.Time        `json:"lastCheck,omitempty"`
}

func updateEmptyState() updateState { return updateState{SchemaVersion: 1} }

func updateReadRegular(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("native update file is not a regular file: %s", path)
	}
	if info.Size() > limit {
		return nil, fmt.Errorf("native update file exceeds its size limit: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, opened) {
		return nil, fmt.Errorf("native update file changed while opening: %s", path)
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("native update file exceeds its size limit: %s", path)
	}
	return data, nil
}

func updateEnsureDirectory(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return os.Mkdir(path, 0700)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("native update directory is not a real directory: %s", path)
	}
	return nil
}

func updatePrepareRoot(home string) (string, error) {
	if !filepath.IsAbs(home) {
		return "", errors.New("native update home must be an absolute path")
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", err
	}
	root := filepath.Join(resolved, "native-update")
	if err := updateEnsureDirectory(root); err != nil {
		return "", err
	}
	for _, name := range []string{"metadata", "releases"} {
		if err := updateEnsureDirectory(filepath.Join(root, name)); err != nil {
			return "", err
		}
	}
	return root, nil
}

func updateSyncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func updateAtomicWrite(path string, data []byte, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to replace non-regular update file %s", path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".native-update-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err = file.Chmod(mode); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	return updateSyncDirectory(filepath.Dir(path))
}

func updateLoadState(root string) (updateState, error) {
	state := updateEmptyState()
	data, err := updateReadRegular(filepath.Join(root, "state.json"), 64*1024)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := updateDecodeStrict(data, &state); err != nil {
		return state, fmt.Errorf("invalid native update state: %w", err)
	}
	if state.SchemaVersion != 1 || len(state.BlockedVersions) > 128 {
		return state, errors.New("invalid native update state header")
	}
	if state.RollbackFrom != "" {
		if _, err := updateParseVersion(state.RollbackFrom); err != nil {
			return state, err
		}
	}
	if state.HighestSequence > 0 && !updateDigestPattern.MatchString(state.HighestDigest) {
		return state, errors.New("invalid native update sequence watermark")
	}
	for _, blocked := range state.BlockedVersions {
		if _, err := updateParseVersion(blocked); err != nil {
			return state, err
		}
	}
	for _, record := range []*updateInstalled{state.Current, state.Previous} {
		if record != nil {
			if err := updateValidateRecord(*record); err != nil {
				return state, err
			}
		}
	}
	return state, nil
}

func updateSaveState(root string, state updateState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return updateAtomicWrite(filepath.Join(root, "state.json"), append(data, '\n'), 0600)
}

func updateValidateRecord(record updateInstalled) error {
	if !updateInstancePattern.MatchString(record.Instance) {
		return errors.New("invalid native release instance")
	}
	if _, err := updateParseVersion(record.Version); err != nil {
		return err
	}
	parts := strings.Split(record.Target, "-")
	if len(parts) != 3 || parts[0] != "go" {
		return errors.New("invalid installed native target")
	}
	if _, err := updatePlatformTarget(parts[1], parts[2]); err != nil {
		return err
	}
	if !updateDigestPattern.MatchString(record.SHA256) || !updateDigestPattern.MatchString(record.ManifestDigest) || record.Size < 1 || record.Size > updateBinaryLimit {
		return errors.New("invalid installed native artifact")
	}
	return nil
}

func updatePayloadPath(root string, record updateInstalled) string {
	name := "bbx"
	if strings.HasPrefix(record.Target, "go-windows-") {
		name += ".exe"
	}
	return filepath.Join(root, "releases", record.Version, record.SHA256, record.Instance, name)
}

func updateValidatePayloadDirectories(root string, record updateInstalled, create bool) error {
	for _, dir := range []string{filepath.Join(root, "releases"), filepath.Join(root, "releases", record.Version), filepath.Join(root, "releases", record.Version, record.SHA256), filepath.Dir(updatePayloadPath(root, record))} {
		if create {
			if err := updateEnsureDirectory(dir); err != nil {
				return err
			}
		} else {
			info, err := os.Lstat(dir)
			if err != nil {
				return err
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("native release directory is not a real directory: %s", dir)
			}
		}
	}
	return nil
}

func updateVerifyPayload(root string, record updateInstalled) error {
	if err := updateValidateRecord(record); err != nil {
		return err
	}
	if err := updateValidatePayloadDirectories(root, record, false); err != nil {
		return err
	}
	path := updatePayloadPath(root, record)
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != record.Size {
		return fmt.Errorf("installed native executable has an invalid type or size: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, opened) {
		return errors.New("native executable changed during verification")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(file, record.Size+1))
	if err != nil {
		return err
	}
	if size != record.Size || hex.EncodeToString(hash.Sum(nil)) != record.SHA256 {
		return errors.New("installed native executable digest verification failed")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
		return errors.New("installed native payload is not executable")
	}
	return nil
}

func updateReadProof(root string, record updateInstalled, trust updateTrust, now time.Time) (updateArtifact, error) {
	if err := updateValidateRecord(record); err != nil {
		return updateArtifact{}, err
	}
	// Historical signed release proofs remain usable for offline startup and an
	// explicit rollback. Freshness is required when selecting a network update.
	raw, err := updateReadRegular(filepath.Join(root, "metadata", record.ManifestDigest+".json"), updateMetadataLimit)
	if err != nil {
		return updateArtifact{}, err
	}
	feed, err := updateVerifyFeed(raw, trust, now, false)
	if err != nil {
		return updateArtifact{}, err
	}
	if feed.Digest != record.ManifestDigest {
		return updateArtifact{}, errors.New("installed native release proof digest mismatch")
	}
	for _, release := range feed.Manifest.Releases {
		if release.Version != record.Version {
			continue
		}
		artifact, ok := release.Artifacts[record.Target]
		if ok && artifact.SHA256 == record.SHA256 && artifact.Size == record.Size {
			return artifact, nil
		}
	}
	return updateArtifact{}, errors.New("installed native release is not authorized by its signed metadata")
}

func updateCheckWatermark(state updateState, feed updateVerifiedFeed) error {
	if feed.Manifest.Sequence < state.HighestSequence {
		return errors.New("native update metadata sequence rollback rejected")
	}
	if feed.Manifest.Sequence == state.HighestSequence && state.HighestDigest != "" && feed.Digest != state.HighestDigest {
		return errors.New("native update metadata changed without increasing its sequence")
	}
	return nil
}

func updateBlockVersion(state *updateState, version string) {
	if !installContains(state.BlockedVersions, version) {
		state.BlockedVersions = append(state.BlockedVersions, version)
	}
	if len(state.BlockedVersions) > 128 {
		state.BlockedVersions = state.BlockedVersions[len(state.BlockedVersions)-128:]
	}
}

func updateWaitForLock(ctx context.Context) error {
	timer := time.NewTimer(50 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func updateOpenLock(root string) (*os.File, error) {
	path := filepath.Join(root, "update.lock")
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("native update lock is not a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		file.Close()
		return nil, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(info, opened) {
		file.Close()
		return nil, errors.New("native update lock changed while opening")
	}
	return file, nil
}

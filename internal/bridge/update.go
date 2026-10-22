package bridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type updateManager struct {
	Root           string
	Executable     string
	Version        string
	Target         string
	Trust          updateTrust
	HTTP           updateHTTPClient
	Now            func() time.Time
	Probe          func(context.Context, string, string, string) error
	BeforeActivate func(context.Context) error
	Automatic      bool
}

func newNativeUpdater(c config) (*updateManager, error) {
	if c.remote {
		return nil, errors.New("native updates can only manage the local installation")
	}
	trust, err := updateProductionTrust()
	if err != nil {
		return nil, err
	}
	target, err := updatePlatformTarget(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return nil, err
	}
	root, err := updatePrepareRoot(c.home)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	return &updateManager{Root: root, Executable: executable, Version: version, Target: target, Trust: trust, HTTP: updateDefaultHTTPClient(), Now: time.Now, Probe: func(ctx context.Context, path, candidateVersion, candidateTarget string) error {
		if err := updateProbeExecutable(ctx, path, candidateVersion, candidateTarget); err != nil {
			return err
		}
		// Verify that the candidate understands managed activation and carries
		// usable pinned trust. This also tests the selected proof after commit.
		raw, err := updateProbeCommand(ctx, path, []string{"update", "status"}, c.home)
		if err != nil {
			return err
		}
		status, err := decodeObject(raw)
		if err != nil {
			return err
		}
		if status.text("runtime") != "go" || status.text("runningVersion") != candidateVersion || !status.boolean("configured") {
			return errors.New("candidate lacks configured native update support")
		}
		if status.text("executable") == path && !status.boolean("verified") {
			return errors.New("candidate cannot verify its activated release")
		}
		return nil
	}}, nil
}

func (manager *updateManager) fetch(ctx context.Context, state updateState) (updateVerifiedFeed, error) {
	var buffer bytes.Buffer
	if _, err := updateDownload(ctx, manager.HTTP, manager.Trust.FeedURL, updateMetadataLimit, &buffer); err != nil {
		return updateVerifiedFeed{}, err
	}
	feed, err := updateVerifyFeed(buffer.Bytes(), manager.Trust, manager.Now(), true)
	if err != nil {
		return feed, err
	}
	if err := updateCheckWatermark(state, feed); err != nil {
		return feed, err
	}
	return feed, nil
}

func (manager *updateManager) verifyInstalled(record updateInstalled) error {
	if record.Target != manager.Target {
		return errors.New("installed native release has the wrong platform target")
	}
	if _, err := updateReadProof(manager.Root, record, manager.Trust, manager.Now()); err != nil {
		return err
	}
	return updateVerifyPayload(manager.Root, record)
}

func (manager *updateManager) stage(ctx context.Context, feed updateVerifiedFeed, release updateRelease) (updateInstalled, error) {
	return manager.stageFrom(ctx, feed, release, "")
}

func (manager *updateManager) stageFrom(ctx context.Context, feed updateVerifiedFeed, release updateRelease, source string) (updateInstalled, error) {
	artifact, exists := release.Artifacts[manager.Target]
	if !exists {
		return updateInstalled{}, errors.New("signed native release has no artifact for this platform")
	}
	record := updateInstalled{Instance: uniqueID(), Version: release.Version, Target: manager.Target, SHA256: artifact.SHA256, Size: artifact.Size, ManifestDigest: feed.Digest}
	if err := updateValidatePayloadDirectories(manager.Root, record, true); err != nil {
		return record, err
	}
	directory := filepath.Dir(updatePayloadPath(manager.Root, record))
	complete := false
	defer func() {
		if !complete {
			_ = os.RemoveAll(directory)
		}
	}()
	file, err := os.CreateTemp(directory, ".download-*")
	if err != nil {
		return record, err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	hash := sha256.New()
	var size int64
	var downloadErr error
	if source == "" {
		size, downloadErr = updateDownload(ctx, manager.HTTP, artifact.URL, artifact.Size, io.MultiWriter(file, hash))
	} else {
		data, readErr := updateReadRegular(source, artifact.Size)
		downloadErr = readErr
		if downloadErr == nil {
			size, downloadErr = io.Copy(io.MultiWriter(file, hash), bytes.NewReader(data))
		}
	}
	if downloadErr == nil && (size != artifact.Size || hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256) {
		downloadErr = errors.New("native artifact digest or exact-size verification failed")
	}
	if downloadErr == nil {
		downloadErr = file.Chmod(0755)
	}
	if downloadErr == nil {
		downloadErr = file.Sync()
	}
	closeErr := file.Close()
	if downloadErr != nil {
		return record, downloadErr
	}
	if closeErr != nil {
		return record, closeErr
	}
	path := updatePayloadPath(manager.Root, record)
	if err := os.Rename(temporary, path); err != nil {
		return record, err
	}
	if err := updateSyncDirectory(directory); err != nil {
		return record, err
	}
	if err := updateAtomicWrite(filepath.Join(manager.Root, "metadata", feed.Digest+".json"), feed.Envelope, 0600); err != nil {
		return record, err
	}
	if err := manager.verifyInstalled(record); err != nil {
		return record, err
	}
	if err := manager.Probe(ctx, path, record.Version, record.Target); err != nil {
		return record, fmt.Errorf("native candidate self-test failed: %w", err)
	}
	complete = true
	return record, nil
}

func updateEffectiveVersion(running string, state updateState) (string, error) {
	if _, err := updateParseVersion(running); err != nil {
		return "", err
	}
	if state.Current != nil {
		if state.RollbackFrom != "" {
			comparison, err := updateCompareVersions(running, state.RollbackFrom)
			if err != nil {
				return "", err
			}
			if comparison <= 0 {
				return state.Current.Version, nil
			}
		}
		comparison, err := updateCompareVersions(state.Current.Version, running)
		if err != nil {
			return "", err
		}
		if comparison > 0 {
			return state.Current.Version, nil
		}
	}
	return running, nil
}

func updateDefaultProtocols(current string) []string {
	parts := strings.Split(current, ".")
	if len(parts) != 3 {
		return nil
	}
	return []string{parts[0] + "." + parts[1]}
}

func (manager *updateManager) activate(ctx context.Context, state updateState, record updateInstalled, repair, rollback bool) (object, error) {
	if err := manager.verifyInstalled(record); err != nil {
		return nil, err
	}
	if manager.BeforeActivate != nil {
		if err := manager.BeforeActivate(ctx); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	previous := state
	next := state
	next.Current = &record
	if !repair {
		next.Previous = state.Current
	}
	if rollback {
		next.Previous = nil
		if state.Current != nil {
			next.RollbackFrom = state.Current.Version
			updateBlockVersion(&next, state.Current.Version)
		}
	} else if next.RollbackFrom != "" {
		if comparison, _ := updateCompareVersions(record.Version, next.RollbackFrom); comparison >= 0 {
			next.RollbackFrom = ""
		}
	}
	backup, err := json.MarshalIndent(previous, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := updateAtomicWrite(filepath.Join(manager.Root, "state.backup.json"), append(backup, '\n'), 0600); err != nil {
		return nil, err
	}
	if err := updateSaveState(manager.Root, next); err != nil {
		// A directory-sync error can occur after the rename has committed.
		if restoreErr := updateSaveState(manager.Root, previous); restoreErr != nil {
			return nil, errors.Join(err, fmt.Errorf("activation state restoration failed: %w", restoreErr))
		}
		return nil, err
	}
	// A second probe catches startup failure after activation. Restoration only
	// changes a small state file; the previous executable was never overwritten.
	probeErr := manager.verifyInstalled(record)
	if probeErr == nil {
		probeErr = manager.Probe(ctx, updatePayloadPath(manager.Root, record), record.Version, record.Target)
	}
	if probeErr != nil {
		if !repair && !rollback && ctx.Err() == nil {
			updateBlockVersion(&previous, record.Version)
		}
		if restoreErr := updateSaveState(manager.Root, previous); restoreErr != nil {
			return nil, errors.Join(probeErr, fmt.Errorf("activation rollback failed: %w", restoreErr))
		}
		return nil, fmt.Errorf("native activation failed and the previous selection was restored: %w", probeErr)
	}
	old := manager.Version
	if state.Current != nil {
		old = state.Current.Version
	}
	reason := "updated"
	if repair {
		reason = "repaired"
	}
	if rollback {
		reason = "rolled_back"
	}
	return object{"updated": value(true), "reason": value(reason), "previousVersion": value(old), "version": value(record.Version), "target": value(record.Target), "executable": value(updatePayloadPath(manager.Root, record)), "restartRequired": value(true), "rollbackAvailable": value(next.Previous != nil)}, nil
}

func (manager *updateManager) run(ctx context.Context, action string, supported []string) (object, error) {
	if action != "check" && action != "apply" && action != "install" && action != "repair" && action != "rollback" {
		return nil, fmt.Errorf("unknown native update action %q", action)
	}
	if err := updateValidateTrust(manager.Trust); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	releaseLock, err := updateAcquireLock(ctx, manager.Root)
	if err != nil {
		return nil, err
	}
	defer releaseLock()
	state, err := updateLoadState(manager.Root)
	if err != nil {
		return nil, err
	}
	current, err := updateEffectiveVersion(manager.Version, state)
	if err != nil {
		return nil, err
	}
	if len(supported) == 0 {
		supported = updateDefaultProtocols(current)
	}
	if action == "rollback" {
		if state.Previous == nil {
			return nil, errors.New("no signed previous native release is available for rollback")
		}
		if installContains(state.BlockedVersions, state.Previous.Version) {
			return nil, errors.New("the previous release was already rolled back and is blocked")
		}
		if err := manager.verifyInstalled(*state.Previous); err != nil {
			return nil, err
		}
		if err := manager.Probe(ctx, updatePayloadPath(manager.Root, *state.Previous), state.Previous.Version, state.Previous.Target); err != nil {
			return nil, err
		}
		return manager.activate(ctx, state, *state.Previous, false, true)
	}
	if manager.Automatic {
		if !state.LastCheck.IsZero() && manager.Now().Sub(state.LastCheck) >= 0 && manager.Now().Sub(state.LastCheck) < 24*time.Hour {
			return object{"updated": value(false), "reason": value("check_throttled"), "previousVersion": value(current)}, nil
		}
		state.LastCheck = manager.Now()
		if err := updateSaveState(manager.Root, state); err != nil {
			return nil, err
		}
	}
	feed, err := manager.fetch(ctx, state)
	if err != nil {
		return nil, err
	}
	if err := updateAtomicWrite(filepath.Join(manager.Root, "metadata", feed.Digest+".json"), feed.Envelope, 0600); err != nil {
		return nil, err
	}
	state.HighestSequence, state.HighestDigest, state.LastCheck = feed.Manifest.Sequence, feed.Digest, manager.Now()
	if err := updateSaveState(manager.Root, state); err != nil {
		return nil, err
	}
	pinned := ""
	allowEqual := action == "install" || action == "repair"
	if action == "repair" {
		pinned = current
	}
	selected, err := updateSelectRelease(feed, manager.Target, current, supported, state.BlockedVersions, allowEqual, pinned)
	if err != nil {
		return nil, err
	}
	if selected == nil {
		if action == "repair" || action == "install" {
			return nil, errors.New("no signed, unblocked, non-downgrade release matches this installation and platform")
		}
		return object{"updated": value(false), "reason": value("no_compatible_update"), "previousVersion": value(current)}, nil
	}
	if action == "check" {
		return object{"updated": value(false), "reason": value("update_available"), "previousVersion": value(current), "version": value(selected.Version), "target": value(manager.Target)}, nil
	}
	if state.Current != nil && selected.Version == state.Current.Version {
		artifact := selected.Artifacts[manager.Target]
		if artifact.SHA256 != state.Current.SHA256 || artifact.Size != state.Current.Size {
			return nil, errors.New("signed release contents changed for an already-installed version; publish a new release version")
		}
		if action == "install" && manager.verifyInstalled(*state.Current) == nil {
			return object{"updated": value(false), "reason": value("already_installed"), "version": value(selected.Version)}, nil
		}
	}
	// Adopt an existing release as a rollback point only when fresh signed
	// metadata authenticates its exact executable bytes. A locally built or
	// otherwise unsigned bootstrap is retained but never becomes update trust.
	if state.Current == nil && selected.Version != current && manager.Executable != "" {
		baseline, err := updateSelectRelease(feed, manager.Target, current, updateDefaultProtocols(current), nil, true, current)
		if err != nil {
			return nil, err
		}
		if baseline != nil {
			artifact := baseline.Artifacts[manager.Target]
			data, readErr := updateReadRegular(manager.Executable, updateBinaryLimit)
			if readErr == nil && int64(len(data)) == artifact.Size && updateHash(data) == artifact.SHA256 {
				previous, err := manager.stageFrom(ctx, feed, *baseline, manager.Executable)
				if err != nil {
					return nil, fmt.Errorf("cannot preserve signed previous release: %w", err)
				}
				state.Current = &previous
			}
		}
	}
	record, err := manager.stage(ctx, feed, *selected)
	if err != nil {
		return nil, err
	}
	repair := state.Current != nil && record.Version == state.Current.Version
	return manager.activate(ctx, state, record, repair, false)
}

type updateProbeBuffer struct {
	bytes.Buffer
	limit    int
	overflow bool
}

func (buffer *updateProbeBuffer) Write(data []byte) (int, error) {
	remaining := buffer.limit - buffer.Len()
	n := len(data)
	if n > remaining {
		buffer.overflow = true
		data = data[:remaining]
	}
	_, _ = buffer.Buffer.Write(data)
	return n, nil
}

func updateProbeExecutable(ctx context.Context, path, wantVersion, wantTarget string) error {
	raw, err := updateProbeCommand(ctx, path, []string{"--self-test"}, "")
	if err != nil {
		return err
	}
	var result struct {
		Version     string `json:"version"`
		Target      string `json:"target"`
		Runtime     string `json:"runtime"`
		MethodCount int    `json:"methodCount"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return err
	}
	if result.Version != wantVersion || result.Target != wantTarget || result.Runtime != "go" || result.MethodCount <= 0 {
		return errors.New("native candidate self-test version, target, or runtime mismatch")
	}
	return nil
}

func updateProbeCommand(ctx context.Context, path string, args []string, home string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, path, args...)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "BBX_REMOTE" || key == "BBX_AUTO_UPDATE" || home != "" && key == "BROWSER_BRIDGE_HOME" {
			continue
		}
		command.Env = append(command.Env, entry)
	}
	command.Env = append(command.Env, "BBX_AUTO_UPDATE=off")
	if home != "" {
		command.Env = append(command.Env, "BROWSER_BRIDGE_HOME="+home)
	}
	stdout, stderr := &updateProbeBuffer{limit: 64 * 1024}, &updateProbeBuffer{limit: 16 * 1024}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("candidate execution: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if stdout.overflow || stderr.overflow {
		return nil, errors.New("native candidate self-test output exceeded its limit")
	}
	return stdout.Bytes(), nil
}

func handleUpdateCommand(ctx context.Context, c config, args []string) (bool, error) {
	if len(args) == 0 || args[0] != "update" {
		return false, nil
	}
	if npmManagedRuntime() && (len(args) != 2 || args[1] != "status") {
		return true, errors.New("npm manages this runtime version; use `npm install -g @browserbridge/bbx@<version>` to update it")
	}
	if c.remote {
		return true, errors.New("native update commands only manage the local installation")
	}
	action := "apply"
	if len(args) > 2 {
		return true, errors.New("usage: bbx update [check|apply|install|repair|rollback|status]")
	}
	if len(args) == 2 {
		action = args[1]
	}
	if action == "status" {
		result, err := nativeUpdateStatus(c)
		if err != nil {
			return true, err
		}
		return true, printJSON(result)
	}
	switch action {
	case "check", "apply", "install", "repair", "rollback":
	default:
		return true, errors.New("usage: bbx update [check|apply|install|repair|rollback|status]")
	}
	manager, err := newNativeUpdater(c)
	if err != nil {
		return true, err
	}
	result, err := manager.run(ctx, action, nil)
	if err != nil {
		return true, err
	}
	return true, printJSON(result)
}

func nativeUpdateStatus(c config) (object, error) {
	if npmManagedRuntime() {
		return object{"runtime": value("go"), "distribution": value("npm"), "runningVersion": value(version), "managed": value(true), "updateCommand": value("npm install -g @browserbridge/bbx@<version>")}, nil
	}
	result := object{"runtime": value("go"), "runningVersion": value(version), "configured": value(false), "managed": value(false)}
	root := filepath.Join(c.home, "native-update")
	state, err := updateLoadState(root)
	if err != nil {
		return nil, err
	}
	trust, trustErr := updateProductionTrust()
	result["configured"] = value(trustErr == nil)
	if trustErr != nil {
		result["configurationError"] = value(trustErr.Error())
	}
	if state.Current != nil {
		result["managed"], result["version"], result["target"] = value(true), value(state.Current.Version), value(state.Current.Target)
		result["executable"] = value(updatePayloadPath(root, *state.Current))
		integrityErr := trustErr
		if integrityErr == nil {
			_, integrityErr = updateReadProof(root, *state.Current, trust, time.Now())
		}
		if integrityErr == nil {
			integrityErr = updateVerifyPayload(root, *state.Current)
		}
		result["verified"] = value(integrityErr == nil)
		if integrityErr != nil {
			result["integrityError"] = value(integrityErr.Error())
		}
	}
	if state.Previous != nil {
		result["previousVersion"] = value(state.Previous.Version)
	}
	result["blockedVersions"] = value(append([]string{}, state.BlockedVersions...))
	result["highestSequence"] = value(state.HighestSequence)
	return result, nil
}

func updateReadPolicy(c config) (string, error) {
	if env, exists := os.LookupEnv("BBX_AUTO_UPDATE"); exists {
		if env != "off" && env != "compatible" {
			return "", errors.New("auto-update policy must be off or compatible")
		}
		return env, nil
	}
	raw, err := os.ReadFile(filepath.Join(c.home, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return "off", nil
	}
	if err != nil {
		return "", err
	}
	settings, err := decodeObject(raw)
	if err != nil {
		return "", err
	}
	policy := settings.text("autoUpdate")
	if policy == "" {
		if _, present := settings["autoUpdate"]; present {
			return "", errors.New("auto-update policy must be off or compatible")
		}
		policy = "off"
	}
	if policy != "off" && policy != "compatible" {
		return "", errors.New("auto-update policy must be off or compatible")
	}
	return policy, nil
}

// Call once after authenticated local health reports a newer extension. A
// successful activation returns restartRequired; the caller must start a fresh
// process and reconnect rather than pretending its loaded code has changed.
func updateCompatibleNative(ctx context.Context, c config, extensionVersion string, supportedVersions []string) (object, error) {
	unchanged := func(reason string) object {
		return object{"updated": value(false), "reason": value(reason), "previousVersion": value(version)}
	}
	if c.remote {
		return unchanged("remote_destination"), nil
	}
	if c.network == "tcp" {
		host, _, err := net.SplitHostPort(c.address)
		if err != nil {
			return nil, err
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return unchanged("remote_destination"), nil
		}
	}
	policy, err := updateReadPolicy(c)
	if err != nil {
		return nil, err
	}
	if policy != "compatible" {
		return unchanged("policy_off"), nil
	}
	extension, err := updateParseVersion(extensionVersion)
	if err != nil || !updateProtocolSupported(extension[0], supportedVersions) {
		return unchanged("invalid_extension_version"), nil
	}
	comparison, err := updateCompareVersions(extensionVersion, version)
	if err != nil {
		return unchanged("invalid_installed_version"), nil
	}
	if comparison <= 0 {
		return unchanged("extension_not_newer"), nil
	}
	manager, err := newNativeUpdater(c)
	if err != nil {
		return nil, err
	}
	manager.Automatic = true
	return manager.run(ctx, "apply", supportedVersions)
}

// Call after loadConfig and before dispatching CLI/native/daemon/MCP commands.
// Management and self-test commands stay in the current executable so a damaged
// active payload can be diagnosed or repaired from the untouched bootstrap.
func forwardNativeUpdate(ctx context.Context, c config, args []string) (bool, error) {
	if npmManagedRuntime() {
		return false, nil
	}
	if len(args) > 0 && (args[0] == "update" || args[0] == "--self-test" || args[0] == "install-self") {
		return false, nil
	}
	root := filepath.Join(c.home, "native-update")
	state, err := updateLoadState(root)
	if err != nil {
		return true, err
	}
	if state.Current == nil {
		return false, nil
	}
	effective, err := updateEffectiveVersion(version, state)
	if err != nil {
		return true, err
	}
	if effective != state.Current.Version {
		return false, nil
	} // A manually installed newer binary wins.
	manager, err := newNativeUpdater(c)
	if err != nil {
		return true, err
	}
	if err := manager.verifyInstalled(*state.Current); err != nil {
		return true, fmt.Errorf("active native release failed verification; run `bbx update repair` or `bbx update rollback`: %w", err)
	}
	executable, err := os.Executable()
	if err != nil {
		return true, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return true, err
	}
	active := updatePayloadPath(manager.Root, *state.Current)
	if filepath.Clean(executable) == filepath.Clean(active) {
		return false, nil
	}
	command := exec.CommandContext(ctx, active, args...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := command.Run(); err != nil {
		return true, err
	}
	return true, nil
}

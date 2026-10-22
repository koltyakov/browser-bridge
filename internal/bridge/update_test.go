package bridge

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type updateTestResponse struct {
	body    []byte
	status  int
	headers map[string]string
}

type updateTestFixture struct {
	t         *testing.T
	mu        sync.Mutex
	responses map[string]updateTestResponse
	requests  map[string]int
	server    *httptest.Server
	key       ed25519.PrivateKey
	public    ed25519.PublicKey
	now       time.Time
	manager   *updateManager
}

func updateTestNew(t *testing.T) *updateTestFixture {
	t.Helper()
	public, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f := &updateTestFixture{t: t, key: key, public: public, now: time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC), responses: map[string]updateTestResponse{}, requests: map[string]int{}}
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		f.mu.Lock()
		response, ok := f.responses[request.URL.Path]
		f.requests[request.URL.Path]++
		f.mu.Unlock()
		if !ok {
			http.NotFound(writer, request)
			return
		}
		for key, value := range response.headers {
			writer.Header().Set(key, value)
		}
		if response.status != 0 {
			writer.WriteHeader(response.status)
		}
		_, _ = writer.Write(response.body)
	}))
	t.Cleanup(f.server.Close)
	root, err := updatePrepareRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f.manager = &updateManager{Root: root, Version: "1.0.0", Target: "go-linux-amd64", Trust: updateTrust{FeedURL: f.server.URL + "/feed", Keys: map[string]ed25519.PublicKey{"release": public}, Threshold: 1}, HTTP: f.server.Client(), Now: func() time.Time { return f.now }, Probe: func(_ context.Context, path, version, target string) error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if string(data) != "native:"+version+":"+target {
			return errors.New("fake executable self-test mismatch")
		}
		return nil
	}}
	return f
}

func (f *updateTestFixture) set(path string, response updateTestResponse) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.responses[path] = response
}
func (f *updateTestFixture) count(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[path]
}

func updateTestSign(t *testing.T, manifest updateManifest, key ed25519.PrivateKey, id string) []byte {
	t.Helper()
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	envelope := updateEnvelope{Signed: base64.StdEncoding.EncodeToString(payload), Signatures: []updateSignature{{KeyID: id, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))}}}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (f *updateTestFixture) manifest(sequence uint64, versions ...string) updateManifest {
	manifest := updateManifest{SchemaVersion: 1, Channel: "stable", Sequence: sequence, IssuedAt: f.now.Add(-time.Hour), ExpiresAt: f.now.Add(24 * time.Hour), Releases: []updateRelease{}}
	for _, version := range versions {
		parsed, err := updateParseVersion(version)
		if err != nil {
			f.t.Fatal(err)
		}
		data := []byte("native:" + version + ":" + f.manager.Target)
		path := "/" + version
		f.set(path, updateTestResponse{body: data})
		manifest.Releases = append(manifest.Releases, updateRelease{Version: version, ProtocolMajor: parsed[0], Artifacts: map[string]updateArtifact{f.manager.Target: {URL: f.server.URL + path, SHA256: updateHash(data), Size: int64(len(data))}}})
	}
	return manifest
}

func (f *updateTestFixture) publish(sequence uint64, versions ...string) updateManifest {
	manifest := f.manifest(sequence, versions...)
	f.set("/feed", updateTestResponse{body: updateTestSign(f.t, manifest, f.key, "release")})
	return manifest
}

func (f *updateTestFixture) run(action string) object {
	f.t.Helper()
	result, err := f.manager.run(context.Background(), action, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	return result
}

func TestUpdateSignedInstallUpgradeAndOfflineRollback(t *testing.T) {
	f := updateTestNew(t)
	f.publish(1, "1.0.0")
	installed := f.run("install")
	if !installed.boolean("updated") {
		t.Fatal(installed)
	}
	first, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	firstPath := updatePayloadPath(f.manager.Root, *first.Current)
	firstData, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	f.publish(2, "1.0.0", "1.1.0", "2.0.0")
	checked := f.run("check")
	if checked.text("version") != "1.1.0" || checked.boolean("updated") {
		t.Fatal(checked)
	}
	if f.count("/1.1.0") != 0 {
		t.Fatal("check downloaded an executable")
	}
	updated := f.run("apply")
	if updated.text("version") != "1.1.0" || !updated.boolean("restartRequired") {
		t.Fatal(updated)
	}
	state, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if state.Previous == nil || state.Previous.Version != "1.0.0" || state.HighestSequence != 2 {
		t.Fatalf("state %#v", state)
	}
	data, _ := os.ReadFile(firstPath)
	if !bytes.Equal(data, firstData) {
		t.Fatal("overwrote previous executable")
	}
	if _, err := os.Stat(filepath.Join(f.manager.Root, "state.backup.json")); err != nil {
		t.Fatal(err)
	}
	requests := f.count("/feed")
	f.set("/feed", updateTestResponse{status: 503})
	f.now = f.now.Add(40 * 24 * time.Hour) // Explicit offline rollback accepts historical signed proof.
	rolled := f.run("rollback")
	if rolled.text("version") != "1.0.0" || rolled.text("reason") != "rolled_back" {
		t.Fatal(rolled)
	}
	if f.count("/feed") != requests {
		t.Fatal("offline rollback contacted the network")
	}
	state, err = updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if !installContains(state.BlockedVersions, "1.1.0") || state.HighestSequence != 2 || state.Previous != nil {
		t.Fatalf("rollback state %#v", state)
	}
	f.publish(3, "1.0.0", "1.1.0")
	if result := f.run("apply"); result.text("reason") != "no_compatible_update" {
		t.Fatal(result)
	}
}

func TestUpdateSignatureAuthenticationAndThreshold(t *testing.T) {
	f := updateTestNew(t)
	manifest := f.manifest(1, "1.1.0")
	raw := updateTestSign(t, manifest, f.key, "release")
	if _, err := updateVerifyFeed(raw, f.manager.Trust, f.now, true); err != nil {
		t.Fatal(err)
	}
	var envelope updateEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	payload, _ := base64.StdEncoding.DecodeString(envelope.Signed)
	payload = bytes.Replace(payload, []byte(`"1.1.0"`), []byte(`"1.9.0"`), 1)
	envelope.Signed = base64.StdEncoding.EncodeToString(payload)
	tampered, _ := json.Marshal(envelope)
	f.set("/feed", updateTestResponse{body: tampered})
	if _, err := f.manager.run(context.Background(), "apply", nil); err == nil || !strings.Contains(err.Error(), "signature") {
		t.Fatalf("tampered signature: %v", err)
	}
	if f.count("/1.1.0") != 0 {
		t.Fatal("unauthenticated manifest triggered artifact download")
	}
	unknown := updateTestSign(t, manifest, f.key, "untrusted")
	if _, err := updateVerifyFeed(unknown, f.manager.Trust, f.now, true); err == nil {
		t.Fatal("accepted unknown key")
	}
	secondPublic, secondKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	trust := f.manager.Trust
	trust.Keys = map[string]ed25519.PublicKey{"release": f.public, "second": secondPublic}
	trust.Threshold = 2
	if _, err := updateVerifyFeed(raw, trust, f.now, true); err == nil {
		t.Fatal("one signature satisfied threshold two")
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Signatures = append(envelope.Signatures, envelope.Signatures[0])
	duplicate, _ := json.Marshal(envelope)
	if _, err := updateVerifyFeed(duplicate, trust, f.now, true); err == nil {
		t.Fatal("duplicate key counted twice")
	}
	payload, _ = base64.StdEncoding.DecodeString(envelope.Signed)
	envelope.Signatures = append(envelope.Signatures, updateSignature{KeyID: "second", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(secondKey, payload))})
	multi, _ := json.Marshal(envelope)
	if _, err := updateVerifyFeed(multi, trust, f.now, true); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateRejectsReplayEquivocationAndExpiredMetadata(t *testing.T) {
	f := updateTestNew(t)
	f.publish(5, "1.1.0")
	f.run("check")
	f.publish(4, "1.2.0")
	if _, err := f.manager.run(context.Background(), "apply", nil); err == nil || !strings.Contains(err.Error(), "sequence rollback") {
		t.Fatal(err)
	}
	f.publish(5, "1.2.0")
	if _, err := f.manager.run(context.Background(), "apply", nil); err == nil || !strings.Contains(err.Error(), "without increasing") {
		t.Fatal(err)
	}
	for _, future := range []bool{false, true} {
		manifest := f.manifest(6, "1.2.0")
		if future {
			manifest.IssuedAt = f.now.Add(time.Hour)
			manifest.ExpiresAt = f.now.Add(2 * time.Hour)
		} else {
			manifest.IssuedAt = f.now.Add(-2 * time.Hour)
			manifest.ExpiresAt = f.now.Add(-time.Hour)
		}
		f.set("/feed", updateTestResponse{body: updateTestSign(t, manifest, f.key, "release")})
		if _, err := f.manager.run(context.Background(), "check", nil); err == nil {
			t.Fatal("accepted stale/future metadata")
		}
	}
	if f.count("/1.2.0") != 0 {
		t.Fatal("downloaded artifact from rejected metadata")
	}
}

func TestUpdateRejectsWrongDigestSizeAndHTTPFailures(t *testing.T) {
	for _, kind := range []string{"digest", "short", "long", "status", "compression"} {
		t.Run(kind, func(t *testing.T) {
			f := updateTestNew(t)
			f.publish(1, "1.1.0")
			response := updateTestResponse{body: []byte("native:1.1.0:" + f.manager.Target)}
			switch kind {
			case "digest":
				response.body[0] = 'X'
			case "short":
				response.body = response.body[:len(response.body)-1]
			case "long":
				response.body = append(response.body, 'X')
			case "status":
				response.status = 500
			case "compression":
				response.headers = map[string]string{"Content-Encoding": "gzip"}
			}
			f.set("/1.1.0", response)
			if _, err := f.manager.run(context.Background(), "apply", nil); err == nil {
				t.Fatal("accepted corrupt download")
			}
			state, err := updateLoadState(f.manager.Root)
			if err != nil {
				t.Fatal(err)
			}
			if state.Current != nil {
				t.Fatal("activated rejected download")
			}
			if err := filepath.WalkDir(filepath.Join(f.manager.Root, "releases"), func(path string, entry os.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if !entry.IsDir() {
					t.Errorf("left failed download %s", path)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestUpdateActivationFailureRestoresPreviousSelection(t *testing.T) {
	f := updateTestNew(t)
	f.publish(1, "1.0.0")
	f.run("install")
	before, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	f.publish(2, "1.1.0")
	originalProbe := f.manager.Probe
	probes := 0
	f.manager.Probe = func(ctx context.Context, path, version, target string) error {
		probes++
		if probes == 2 {
			return errors.New("simulated post-activation startup failure")
		}
		return originalProbe(ctx, path, version, target)
	}
	if _, err := f.manager.run(context.Background(), "apply", nil); err == nil || !strings.Contains(err.Error(), "previous selection was restored") {
		t.Fatal(err)
	}
	after, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if after.Current.Instance != before.Current.Instance || after.HighestSequence != 2 || !installContains(after.BlockedVersions, "1.1.0") {
		t.Fatalf("failed rollback %#v", after)
	}
	if err := f.manager.verifyInstalled(*after.Current); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateBeforeActivationFailureDoesNotSwitch(t *testing.T) {
	f := updateTestNew(t)
	f.publish(1, "1.0.0")
	f.run("install")
	f.publish(2, "1.1.0")
	f.manager.BeforeActivate = func(context.Context) error { return errors.New("busy") }
	if _, err := f.manager.run(context.Background(), "apply", nil); err == nil || err.Error() != "busy" {
		t.Fatal(err)
	}
	state, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if state.Current.Version != "1.0.0" {
		t.Fatal(state.Current)
	}
}

func TestUpdateRepairUsesNewExecutableInstanceAndPreservesBackup(t *testing.T) {
	f := updateTestNew(t)
	f.manager.Target = "go-windows-amd64"
	f.publish(1, "1.0.0")
	f.run("install")
	f.publish(2, "1.1.0")
	f.run("apply")
	before, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	oldPath := updatePayloadPath(f.manager.Root, *before.Current)
	if filepath.Ext(oldPath) != ".exe" {
		t.Fatal(oldPath)
	}
	// Keep a handle open to model a running Windows image. Repair never renames,
	// deletes or writes this file; it publishes a new immutable instance instead.
	open, err := os.Open(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	defer open.Close()
	if runtime.GOOS != "windows" {
		if err := os.WriteFile(oldPath, []byte("damaged"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	result := f.run("repair")
	if result.text("reason") != "repaired" {
		t.Fatal(result)
	}
	after, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if after.Current.Instance == before.Current.Instance || after.Previous.Instance != before.Previous.Instance {
		t.Fatal("repair overwrote current or discarded rollback version")
	}
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatal("repair deleted running executable")
	}
	if err := f.manager.verifyInstalled(*after.Current); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateImmutableReleaseAndTamperedRollback(t *testing.T) {
	f := updateTestNew(t)
	f.publish(1, "1.0.0")
	f.run("install")
	manifest := f.manifest(2, "1.0.0")
	artifact := manifest.Releases[0].Artifacts[f.manager.Target]
	artifact.SHA256 = strings.Repeat("a", 64)
	manifest.Releases[0].Artifacts[f.manager.Target] = artifact
	f.set("/feed", updateTestResponse{body: updateTestSign(t, manifest, f.key, "release")})
	if _, err := f.manager.run(context.Background(), "repair", nil); err == nil || !strings.Contains(err.Error(), "contents changed") {
		t.Fatal(err)
	}
	f.publish(3, "1.1.0")
	f.run("apply")
	state, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(updatePayloadPath(f.manager.Root, *state.Previous), []byte("tampered"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := f.manager.run(context.Background(), "rollback", nil); err == nil {
		t.Fatal("activated tampered rollback binary")
	}
	after, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	if after.Current.Instance != state.Current.Instance {
		t.Fatal("failed rollback changed selection")
	}
}

func TestUpdatePlatformCompatibilityAndNoDowngrade(t *testing.T) {
	for _, pair := range [][2]string{{"darwin", "amd64"}, {"darwin", "arm64"}, {"linux", "amd64"}, {"linux", "arm64"}, {"windows", "amd64"}} {
		if _, err := updatePlatformTarget(pair[0], pair[1]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := updatePlatformTarget("windows", "arm64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
	f := updateTestNew(t)
	manifest := f.manifest(1, "0.9.0", "1.1.0", "1.10.0", "2.0.0")
	feed, err := updateVerifyFeed(updateTestSign(t, manifest, f.key, "release"), f.manager.Trust, f.now, true)
	if err != nil {
		t.Fatal(err)
	}
	release, err := updateSelectRelease(feed, f.manager.Target, "1.0.0", []string{"1.9"}, nil, false, "")
	if err != nil || release == nil || release.Version != "1.10.0" {
		t.Fatal(release, err)
	}
	release, err = updateSelectRelease(feed, f.manager.Target, "1.10.0", []string{"1.0"}, nil, false, "")
	if err != nil || release != nil {
		t.Fatal("downgrade selected", release, err)
	}
	release, err = updateSelectRelease(feed, f.manager.Target, "1.10.0", []string{"2.0"}, nil, false, "")
	if err != nil || release == nil || release.Version != "2.0.0" {
		t.Fatal(release, err)
	}
	release, err = updateSelectRelease(feed, "go-linux-arm64", "1.0.0", []string{"1.0"}, nil, false, "")
	if err != nil || release != nil {
		t.Fatal("wrong-platform artifact selected")
	}
	state := updateState{Current: &updateInstalled{Version: "1.0.0"}, RollbackFrom: "2.0.0"}
	if effective, err := updateEffectiveVersion("2.0.0", state); err != nil || effective != "1.0.0" {
		t.Fatal("explicit rollback ignored", effective, err)
	}
	if effective, err := updateEffectiveVersion("2.1.0", state); err != nil || effective != "2.1.0" {
		t.Fatal("manually installed newer executable ignored", effective, err)
	}
}

func TestUpdateSymlinkAndMetadataTamperProtection(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires developer mode")
	}
	f := updateTestNew(t)
	f.publish(1, "1.0.0")
	f.run("install")
	state, err := updateLoadState(f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	path := updatePayloadPath(f.manager.Root, *state.Current)
	outside := filepath.Join(t.TempDir(), "payload")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, data, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, path); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.verifyInstalled(*state.Current); err == nil {
		t.Fatal("accepted executable symlink")
	}
	proof := filepath.Join(f.manager.Root, "metadata", state.Current.ManifestDigest+".json")
	if err := os.WriteFile(proof, []byte(`{"signed":"e30=","signatures":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := updateReadProof(f.manager.Root, *state.Current, f.manager.Trust, f.now); err == nil {
		t.Fatal("accepted tampered release proof")
	}
}

func TestUpdateLockCancellationAndRelease(t *testing.T) {
	f := updateTestNew(t)
	unlock, err := updateAcquireLock(context.Background(), f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if second, err := updateAcquireLock(ctx, f.manager.Root); err == nil {
		second()
		unlock()
		t.Fatal("concurrent updater acquired lock")
	} else if !errors.Is(err, context.DeadlineExceeded) {
		unlock()
		t.Fatal(err)
	}
	unlock()
	second, err := updateAcquireLock(context.Background(), f.manager.Root)
	if err != nil {
		t.Fatal(err)
	}
	second()
}

func TestUpdateMetadataLimitsDuplicateKeysAndUnsafeURLs(t *testing.T) {
	f := updateTestNew(t)
	for _, raw := range []string{"http://example.com/feed", "file:///tmp/update", "https://user:pass@example.com/feed", "https://example.com/feed#fragment"} {
		if err := updateValidateURL(raw); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	if _, err := updateVerifyFeed(bytes.Repeat([]byte(" "), int(updateMetadataLimit+1)), f.manager.Trust, f.now, true); err == nil {
		t.Fatal("accepted oversized metadata")
	}
	manifest := f.manifest(1, "1.1.0")
	payload, _ := json.Marshal(manifest)
	payload = bytes.Replace(payload, []byte(`"sequence":1`), []byte(`"sequence":1,"sequence":2`), 1)
	envelope := updateEnvelope{Signed: base64.StdEncoding.EncodeToString(payload), Signatures: []updateSignature{{KeyID: "release", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.key, payload))}}}
	raw, _ := json.Marshal(envelope)
	if _, err := updateVerifyFeed(raw, f.manager.Trust, f.now, true); err == nil {
		t.Fatal("accepted duplicate signed JSON keys")
	}
	artifact := manifest.Releases[0].Artifacts[f.manager.Target]
	artifact.Size = updateBinaryLimit + 1
	manifest.Releases[0].Artifacts[f.manager.Target] = artifact
	if _, err := updateVerifyFeed(updateTestSign(t, manifest, f.key, "release"), f.manager.Trust, f.now, true); err == nil {
		t.Fatal("accepted oversized binary")
	}
}

func TestUpdateAutomaticThrottlePolicyAndNoTrustBypass(t *testing.T) {
	f := updateTestNew(t)
	f.publish(1, "1.1.0")
	f.manager.Automatic = true
	if result := f.run("apply"); !result.boolean("updated") {
		t.Fatal(result)
	}
	f.publish(2, "1.2.0")
	if result := f.run("apply"); result.text("reason") != "check_throttled" {
		t.Fatal(result)
	}
	if f.count("/feed") != 1 {
		t.Fatal("automatic updater ignored daily throttle")
	}
	c := config{home: t.TempDir(), network: "tcp", address: "127.0.0.1:9223"}
	t.Setenv("BBX_AUTO_UPDATE", "off")
	result, err := updateCompatibleNative(context.Background(), c, "99.0.0", []string{"99.0"})
	if err != nil || result.text("reason") != "policy_off" {
		t.Fatal(result, err)
	}
	t.Setenv("BBX_AUTO_UPDATE", "compatible")
	c.remote = true
	result, err = updateCompatibleNative(context.Background(), c, "99.0.0", []string{"99.0"})
	if err != nil || result.text("reason") != "remote_destination" {
		t.Fatal(result, err)
	}
	c.remote = false
	c.address = "192.0.2.1:9223"
	result, err = updateCompatibleNative(context.Background(), c, "99.0.0", []string{"99.0"})
	if err != nil || result.text("reason") != "remote_destination" {
		t.Fatal(result, err)
	}
	t.Setenv("BBX_UPDATE_PUBLIC_KEY", base64.StdEncoding.EncodeToString(f.public))
	t.Setenv("BBX_UPDATE_FEED", f.server.URL+"/feed")
	t.Setenv("BBX_UPDATE_ALLOW_UNSIGNED", "1")
	// Environment variables must never provision or disable update trust.
	beforeFeed, beforeKeys := nativeUpdateFeedURL, nativeUpdateKeysJSON
	nativeUpdateFeedURL, nativeUpdateKeysJSON = "", ""
	t.Cleanup(func() { nativeUpdateFeedURL, nativeUpdateKeysJSON = beforeFeed, beforeKeys })
	if _, err := updateProductionTrust(); err == nil {
		t.Fatal("environment bypassed compiled trust configuration")
	}
}

type updateTestClient func(*http.Request) (*http.Response, error)

func (client updateTestClient) Do(request *http.Request) (*http.Response, error) {
	return client(request)
}

func TestUpdateStreamingLimitAndContextCancellation(t *testing.T) {
	client := updateTestClient(func(request *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(strings.Repeat("X", 100))), ContentLength: -1, Header: http.Header{}, Request: request}, nil
	})
	var buffer bytes.Buffer
	if _, err := updateDownload(context.Background(), client, "https://example.com/file", 10, &buffer); err == nil || buffer.Len() != 11 {
		t.Fatalf("unbounded download: %d %v", buffer.Len(), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client = updateTestClient(func(request *http.Request) (*http.Response, error) { return nil, request.Context().Err() })
	if _, err := updateDownload(ctx, client, "https://example.com/file", 10, &buffer); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestUpdateRedirectCannotDowngradeHTTPS(t *testing.T) {
	f := updateTestNew(t)
	insecureRequests := 0
	var mutex sync.Mutex
	insecure := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		mutex.Lock()
		insecureRequests++
		mutex.Unlock()
		_, _ = writer.Write([]byte("unsigned"))
	}))
	defer insecure.Close()
	client := updateDefaultHTTPClient()
	client.Transport = f.server.Client().Transport
	f.manager.HTTP = client
	f.set("/feed", updateTestResponse{status: http.StatusFound, headers: map[string]string{"Location": insecure.URL + "/feed"}})
	if _, err := f.manager.run(context.Background(), "check", nil); err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatal(err)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if insecureRequests != 0 {
		t.Fatal("followed an insecure redirect before rejecting it")
	}
}

func TestUpdateCommandNamespaceAndManagementEscape(t *testing.T) {
	c := config{home: t.TempDir()}
	if handled, err := handleUpdateCommand(context.Background(), c, []string{"rollback", "patch-id"}); handled || err != nil {
		t.Fatal("intercepted DOM patch rollback", handled, err)
	}
	if handled, err := handleUpdateCommand(context.Background(), c, []string{"update", "unknown"}); !handled || err == nil || !strings.Contains(err.Error(), "usage:") {
		t.Fatal(handled, err)
	}
	if handled, err := forwardNativeUpdate(context.Background(), c, []string{"update", "repair"}); handled || err != nil {
		t.Fatal("management command was forwarded", handled, err)
	}
	if handled, err := forwardNativeUpdate(context.Background(), c, []string{"--self-test"}); handled || err != nil {
		t.Fatal("candidate self-test was forwarded", handled, err)
	}
	if handled, err := forwardNativeUpdate(context.Background(), c, []string{"status"}); handled || err != nil {
		t.Fatal("unmanaged installation required updater trust", handled, err)
	}
}

func TestUpdateCandidateProbeChecksActualExecutableOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX executable script")
	}
	path := filepath.Join(t.TempDir(), "candidate")
	script := "#!/bin/sh\nprintf '%s\\n' '{\"version\":\"1.2.3\",\"target\":\"go-linux-amd64\",\"runtime\":\"go\",\"methodCount\":10}'\n"
	if err := os.WriteFile(path, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	if err := updateProbeExecutable(context.Background(), path, "1.2.3", "go-linux-amd64"); err != nil {
		t.Fatal(err)
	}
	if err := updateProbeExecutable(context.Background(), path, "1.2.4", "go-linux-amd64"); err == nil {
		t.Fatal("accepted candidate with mismatched release version")
	}
	if err := updateProbeExecutable(context.Background(), path, "1.2.3", "go-windows-amd64"); err == nil {
		t.Fatal("accepted wrong-platform executable")
	}
}

func TestUpdateFirstUpgradePreservesAuthenticatedBootstrap(t *testing.T) {
	f := updateTestNew(t)
	f.manager.Executable = filepath.Join(t.TempDir(), "original-bbx")
	original := []byte("native:1.0.0:" + f.manager.Target)
	if err := os.WriteFile(f.manager.Executable, original, 0755); err != nil {
		t.Fatal(err)
	}
	f.publish(1, "1.0.0", "1.1.0")
	result := f.run("apply")
	if !result.boolean("rollbackAvailable") {
		t.Fatal(result)
	}
	if f.count("/1.0.0") != 0 {
		t.Fatal("redownloaded an authenticated local bootstrap")
	}
	current, err := os.ReadFile(f.manager.Executable)
	if err != nil || !bytes.Equal(current, original) {
		t.Fatal("modified the running bootstrap", err)
	}
	result = f.run("rollback")
	if result.text("version") != "1.0.0" {
		t.Fatal(result)
	}
}

func TestUpdateDoesNotAuthorizeUnsignedBootstrapForRollback(t *testing.T) {
	f := updateTestNew(t)
	f.manager.Executable = filepath.Join(t.TempDir(), "local-build")
	if err := os.WriteFile(f.manager.Executable, []byte("my local build"), 0755); err != nil {
		t.Fatal(err)
	}
	f.publish(1, "1.0.0", "1.1.0")
	if result := f.run("apply"); result.boolean("rollbackAvailable") {
		t.Fatal("unsigned executable became a rollback point")
	}
	if _, err := f.manager.run(context.Background(), "rollback", nil); err == nil {
		t.Fatal("allowed unsigned rollback")
	}
}

package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func updateGitHubTestNew(t *testing.T) *updateTestFixture {
	t.Helper()
	f := updateTestNew(t)
	f.manager.GitHub = true
	f.manager.HTTP = updateTestClient(func(request *http.Request) (*http.Response, error) {
		copy := request.Clone(request.Context())
		endpoint := f.server.URL + request.URL.Path
		if request.URL.RawQuery != "" {
			endpoint += "?" + request.URL.RawQuery
		}
		forward, err := http.NewRequestWithContext(copy.Context(), http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		response, err := f.server.Client().Do(forward)
		if response != nil {
			response.Request = request
		}
		return response, err
	})
	return f
}

func updateGitHubTestRelease(f *updateTestFixture, version string) updateGitHubRelease {
	f.t.Helper()
	no := false
	name := updateGitHubAssetName(f.manager.Target)
	base := nativeUpdateGitHubDownloads + "/v" + version + "/"
	data := []byte("native:" + version + ":" + f.manager.Target)
	checksums := updateHash(data) + "  " + name + "\n"
	path := "/koltyakov/browser-bridge/releases/download/v" + version + "/"
	f.set(path+name, updateTestResponse{body: data})
	f.set(path+"checksums.txt", updateTestResponse{body: []byte(checksums)})
	return updateGitHubRelease{Tag: "v" + version, Draft: &no, Prerelease: &no, Assets: []updateGitHubAsset{
		{Name: name, URL: base + name, Size: int64(len(data))},
		{Name: "checksums.txt", URL: base + "checksums.txt", Size: int64(len(checksums))},
	}}
}

func updateGitHubTestPublish(f *updateTestFixture, releases ...updateGitHubRelease) {
	f.t.Helper()
	if releases == nil {
		releases = []updateGitHubRelease{}
	}
	raw, err := json.Marshal(releases)
	if err != nil {
		f.t.Fatal(err)
	}
	f.set("/repos/koltyakov/browser-bridge/releases", updateTestResponse{body: raw})
}

func TestUpdateGitHubAutomaticExtensionUpgradeAndPeriodicPatches(t *testing.T) {
	f := updateGitHubTestNew(t)
	f.manager.Version = "2.2.1"
	f.manager.Automatic = true
	f.manager.ExtensionVersion = "2.2.1"
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, "2.2.1"))
	if result := f.run("apply"); result.text("reason") != "no_compatible_update" {
		t.Fatal(result)
	}
	updateGitHubTestPublish(f,
		updateGitHubTestRelease(f, "2.4.99"),
		updateGitHubTestRelease(f, "2.3.9"),
		updateGitHubTestRelease(f, "2.3.10"),
		updateGitHubTestRelease(f, "2.3.0"),
	)
	f.manager.ExtensionVersion = "2.3.0" // New minor bypasses the same-day throttle.
	if result := f.run("apply"); result.text("version") != "2.3.10" || !result.boolean("restartRequired") {
		t.Fatal(result)
	}
	f.manager.ExtensionVersion = "2.2.1" // Another browser is still on the older line.
	f.now = f.now.Add(25 * time.Hour)
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, "2.3.11"), updateGitHubTestRelease(f, "2.4.99"))
	if result := f.run("apply"); result.text("version") != "2.3.11" {
		t.Fatal("older browser lowered the selected line", result)
	}
	f.manager.ExtensionVersion = "" // No browser has reconnected for the next patch.
	f.now = f.now.Add(25 * time.Hour)
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, "2.3.12"))
	if result := f.run("apply"); result.text("version") != "2.3.12" {
		t.Fatal("periodic check required an extension event", result)
	}
	state, err := updateLoadState(f.manager.Root)
	if err != nil || state.LastExtensionVersion != "2.3.0" || state.Current.Source != "github" {
		t.Fatal(state, err)
	}
	if f.count("/koltyakov/browser-bridge/releases/download/v2.4.99/"+updateGitHubAssetName(f.manager.Target)) != 0 {
		t.Fatal("downloaded an unrelated newer minor")
	}
	f.set("/repos/koltyakov/browser-bridge/releases", updateTestResponse{status: 503})
	if result := f.run("rollback"); result.text("version") != "2.3.11" {
		t.Fatal("offline rollback failed", result)
	}
	state, _ = updateLoadState(f.manager.Root)
	if err := f.manager.verifyInstalled(*state.Current); err != nil {
		t.Fatal("offline startup integrity", err)
	}
}

func TestUpdateGitHubStableSelectionAndNonDowngrade(t *testing.T) {
	f := updateGitHubTestNew(t)
	f.manager.Version = "2.3.0"
	releases := []updateGitHubRelease{
		updateGitHubTestRelease(f, "2.3.9"), updateGitHubTestRelease(f, "2.3.10"),
		updateGitHubTestRelease(f, "2.4.0"), updateGitHubTestRelease(f, "3.0.0"),
		updateGitHubTestRelease(f, "2.3.99"), updateGitHubTestRelease(f, "2.3.98"),
	}
	yes := true
	releases[4].Draft, releases[5].Prerelease = &yes, &yes
	releases = append(releases, updateGitHubRelease{Tag: "native-updates"}, updateGitHubRelease{Tag: "v2.3.100"})
	updateGitHubTestPublish(f, releases...)
	result := f.run("check")
	if result.text("version") != "2.3.10" || result.boolean("updated") {
		t.Fatal(result)
	}
	if f.count("/koltyakov/browser-bridge/releases/download/v2.3.10/"+updateGitHubAssetName(f.manager.Target)) != 0 {
		t.Fatal("check downloaded an executable")
	}
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, "2.2.99"))
	if result := f.run("apply"); result.text("reason") != "no_compatible_update" {
		t.Fatal("downgraded or crossed lines", result)
	}
}

func TestUpdateGitHubAssetAndChecksumFailuresPreserveSelection(t *testing.T) {
	for _, kind := range []string{"missing asset", "duplicate asset", "foreign asset", "oversized asset", "missing checksums", "duplicate checksum", "bad checksum", "truncated checksums", "corrupt binary", "wrong size", "self test", "api unavailable", "malformed api"} {
		t.Run(kind, func(t *testing.T) {
			f := updateGitHubTestNew(t)
			f.runFixtureGitHubInstall()
			before, _ := os.ReadFile(filepath.Join(f.manager.Root, "state.json"))
			entry := updateGitHubTestRelease(f, "1.0.1")
			name := updateGitHubAssetName(f.manager.Target)
			path := "/koltyakov/browser-bridge/releases/download/v1.0.1/"
			switch kind {
			case "missing asset":
				entry.Assets = entry.Assets[1:]
			case "duplicate asset":
				entry.Assets = append(entry.Assets, entry.Assets[0])
			case "foreign asset":
				entry.Assets[0].URL = "https://example.com/bbx"
			case "oversized asset":
				entry.Assets[0].Size = updateBinaryLimit + 1
			case "missing checksums":
				entry.Assets = entry.Assets[:1]
			case "duplicate checksum":
				body := strings.Repeat(strings.Repeat("a", 64)+"  "+name+"\n", 2)
				entry.Assets[1].Size = int64(len(body))
				f.set(path+"checksums.txt", updateTestResponse{body: []byte(body)})
			case "bad checksum":
				body := "not-a-digest  " + name + "\n"
				entry.Assets[1].Size = int64(len(body))
				f.set(path+"checksums.txt", updateTestResponse{body: []byte(body)})
			case "truncated checksums":
				f.set(path+"checksums.txt", updateTestResponse{body: []byte("truncated")})
			case "corrupt binary":
				f.set(path+name, updateTestResponse{body: []byte(strings.Repeat("x", int(entry.Assets[0].Size)))})
			case "wrong size":
				entry.Assets[0].Size++
			case "self test":
				f.manager.Probe = func(context.Context, string, string, string) error { return errors.New("bad executable") }
			}
			updateGitHubTestPublish(f, entry)
			switch kind {
			case "api unavailable":
				f.set("/repos/koltyakov/browser-bridge/releases", updateTestResponse{status: 403})
			case "malformed api":
				f.set("/repos/koltyakov/browser-bridge/releases", updateTestResponse{body: []byte(`{"message":"rate limited"}`)})
			}
			if _, err := f.manager.run(context.Background(), "apply", nil); err == nil {
				t.Fatal("accepted", kind)
			}
			state, err := updateLoadState(f.manager.Root)
			if err != nil || state.Current == nil || state.Current.Version != "1.0.0" {
				t.Fatal("changed active selection", state, err, string(before))
			}
			if err := f.manager.verifyInstalled(*state.Current); err != nil {
				t.Fatal("damaged installed payload", err)
			}
		})
	}
}

func (f *updateTestFixture) runFixtureGitHubInstall() {
	f.t.Helper()
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, f.manager.Version))
	if result := f.run("install"); !result.boolean("updated") {
		f.t.Fatal(result)
	}
}

func TestUpdateGitHubRejectsChangedInstalledVersionAndProof(t *testing.T) {
	f := updateGitHubTestNew(t)
	f.runFixtureGitHubInstall()
	entry := updateGitHubTestRelease(f, "1.0.0")
	checksums := strings.Repeat("a", 64) + "  " + entry.Assets[0].Name + "\n"
	f.set("/koltyakov/browser-bridge/releases/download/v1.0.0/checksums.txt", updateTestResponse{body: []byte(checksums)})
	updateGitHubTestPublish(f, entry)
	if _, err := f.manager.run(context.Background(), "repair", nil); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatal("accepted changed published bytes", err)
	}
	state, _ := updateLoadState(f.manager.Root)
	proofPath := filepath.Join(f.manager.Root, "metadata", state.Current.ManifestDigest+".json")
	raw, _ := os.ReadFile(proofPath)
	raw = []byte(strings.ReplaceAll(string(raw), updateGitHubRepository, "another/repository"))
	if err := os.WriteFile(proofPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := f.manager.verifyInstalled(*state.Current); err == nil {
		t.Fatal("accepted a foreign/tampered cached proof")
	}
}

func TestUpdateGitHubPaginationIsCompleteAndBounded(t *testing.T) {
	f := updateGitHubTestNew(t)
	f.manager.Version = "2.3.0"
	calls := 0
	f.manager.HTTP = updateTestClient(func(request *http.Request) (*http.Response, error) {
		calls++
		var entries []updateGitHubRelease
		if request.URL.Query().Get("page") == "1" {
			for i := 0; i < 100; i++ {
				entries = append(entries, updateGitHubTestRelease(f, fmt.Sprintf("9.0.%d", i)))
			}
		} else {
			entries = []updateGitHubRelease{updateGitHubTestRelease(f, "2.3.10")}
		}
		raw, _ := json.Marshal(entries)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}, Request: request}, nil
	})
	releases, err := f.manager.githubReleases(context.Background())
	if err != nil || len(releases) != 101 || calls != 2 {
		t.Fatal(len(releases), calls, err)
	}
	// Never choose from a truncated list, even when its first page has a match.
	calls = 0
	f.manager.HTTP = updateTestClient(func(request *http.Request) (*http.Response, error) {
		calls++
		entries := make([]updateGitHubRelease, 100)
		raw, _ := json.Marshal(entries)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(raw)), Header: http.Header{}, Request: request}, nil
	})
	if _, err := f.manager.githubReleases(context.Background()); err == nil || calls != 20 {
		t.Fatal("unbounded or silently truncated pagination", calls, err)
	}
}

func TestUpdateGitHubAllNativeTargetsAndDefaultConfiguration(t *testing.T) {
	for _, platform := range nativePlatformRegistry {
		target := "go-" + platform.goos + "-" + platform.goarch
		if name := updateGitHubAssetName(target); name != platform.asset {
			t.Fatal(target, name, platform.asset)
		}
	}
	if updateGitHubAssetName("go-unsupported-unknown") != "" {
		t.Fatal("accepted an unsupported native platform")
	}
	t.Setenv("BBX_UPDATE_FEED", "https://example.com/feed")
	t.Setenv("BBX_UPDATE_GITHUB_API", "https://example.com/releases")
	t.Setenv("BBX_UPDATE_ALLOW_UNSIGNED", "1")
	manager, err := newNativeUpdater(config{home: t.TempDir()})
	if err != nil || !manager.GitHub || nativeUpdateGitHubAPI != "https://api.github.com/repos/koltyakov/browser-bridge" {
		t.Fatal("default discovery required a feed or accepted runtime endpoint overrides", err)
	}
	status, err := nativeUpdateStatus(config{home: t.TempDir()})
	if err != nil || !status.boolean("configured") || status.text("source") != "github" {
		t.Fatal(status, err)
	}
}

func TestUpdateGitHubRedirectPolicy(t *testing.T) {
	client := updateGitHubHTTPClient()
	for _, raw := range []string{"http://github.com/asset", "https://example.com/asset", "https://github.com.evil.test/asset", "https://user:pass@github.com/asset"} {
		request, _ := http.NewRequest(http.MethodGet, raw, nil)
		if err := client.CheckRedirect(request, nil); err == nil {
			t.Fatal("accepted redirect", raw)
		}
	}
	request, _ := http.NewRequest(http.MethodGet, "https://release-assets.githubusercontent.com/asset?signature=fixture", nil)
	if err := client.CheckRedirect(request, nil); err != nil {
		t.Fatal("rejected GitHub asset CDN", err)
	}
	if err := client.CheckRedirect(request, make([]*http.Request, 5)); err == nil {
		t.Fatal("unbounded redirects")
	}
}

func TestUpdateGitHubPeriodicFallbackAndFailedExtensionCheckRetry(t *testing.T) {
	f := updateGitHubTestNew(t)
	f.manager.Version = "2.3.0"
	f.manager.Automatic = true
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, "2.3.1"), updateGitHubTestRelease(f, "2.4.0"))
	if result := f.run("apply"); result.text("version") != "2.3.1" {
		t.Fatal("periodic check without any known extension did not follow the native line", result)
	}
	f.manager.ExtensionVersion = "2.4.0"
	f.set("/repos/koltyakov/browser-bridge/releases", updateTestResponse{status: 503})
	if _, err := f.manager.run(context.Background(), "apply", nil); err == nil {
		t.Fatal("ignored failed extension check")
	}
	updateGitHubTestPublish(f, updateGitHubTestRelease(f, "2.4.1"))
	if result := f.run("apply"); result.text("version") != "2.4.1" {
		t.Fatal("old line's throttle suppressed a retry for the new extension", result)
	}
}

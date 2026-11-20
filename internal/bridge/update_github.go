package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const updateGitHubRepository = "koltyakov/browser-bridge"

// These are build-time endpoints, not runtime settings. Tests compile isolated
// executables against a TLS fixture; shipped builds use only this repository.
var nativeUpdateGitHubAPI = "https://api.github.com/repos/" + updateGitHubRepository
var nativeUpdateGitHubDownloads = "https://github.com/" + updateGitHubRepository + "/releases/download"

func updateGitHubHTTPClient() *http.Client {
	client := updateDefaultHTTPClient()
	checkRedirect := client.CheckRedirect
	client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if err := checkRedirect(request, via); err != nil {
			return err
		}
		switch request.URL.Host {
		case "github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com":
			return nil
		default:
			return errors.New("native release redirected outside GitHub")
		}
	}
	return client
}

func updateGitHubValidateEndpoints() error {
	for _, raw := range []string{nativeUpdateGitHubAPI, nativeUpdateGitHubDownloads} {
		if err := updateValidateURL(raw); err != nil {
			return err
		}
		u, _ := url.Parse(raw)
		if u.RawQuery != "" || strings.HasSuffix(u.Path, "/") {
			return errors.New("invalid compiled GitHub release endpoint")
		}
	}
	return nil
}

type updateGitHubAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

type updateGitHubRelease struct {
	Tag        string              `json:"tag_name"`
	Draft      *bool               `json:"draft"`
	Prerelease *bool               `json:"prerelease"`
	Assets     []updateGitHubAsset `json:"assets"`
}

type updateGitHubReleaseProof struct {
	Release   updateGitHubRelease `json:"release"`
	Checksums string              `json:"checksums"`
}

type updateGitHubProof struct {
	Repository string                     `json:"repository"`
	Releases   []updateGitHubReleaseProof `json:"releases"`
}

func updateGitHubVersion(release updateGitHubRelease) string {
	if release.Draft == nil || *release.Draft || release.Prerelease == nil || *release.Prerelease || !strings.HasPrefix(release.Tag, "v") {
		return ""
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if _, err := updateParseVersion(version); err != nil {
		return ""
	}
	return version
}

func updateGitHubAssetName(target string) string {
	for _, platform := range nativePlatformRegistry {
		if target == "go-"+platform.goos+"-"+platform.goarch {
			return platform.asset
		}
	}
	return ""
}

func updateGitHubFindAsset(release updateGitHubRelease, name string, limit int64) (updateGitHubAsset, error) {
	var found updateGitHubAsset
	count := 0
	for _, asset := range release.Assets {
		if asset.Name == name {
			found, count = asset, count+1
		}
	}
	expected := nativeUpdateGitHubDownloads + "/" + release.Tag + "/" + name
	if count != 1 || found.Size <= 0 || found.Size > limit || found.URL != expected {
		return found, fmt.Errorf("missing, duplicate, invalid, or foreign GitHub release asset %q", name)
	}
	if err := updateValidateURL(expected); err != nil {
		return found, err
	}
	return found, nil
}

func updateGitHubArtifact(proof updateGitHubReleaseProof, target string) (updateArtifact, error) {
	if updateGitHubVersion(proof.Release) == "" {
		return updateArtifact{}, errors.New("invalid published stable GitHub release")
	}
	name := updateGitHubAssetName(target)
	asset, err := updateGitHubFindAsset(proof.Release, name, updateBinaryLimit)
	if err != nil {
		return updateArtifact{}, err
	}
	checksums, err := updateGitHubFindAsset(proof.Release, "checksums.txt", updateMetadataLimit)
	if err != nil {
		return updateArtifact{}, err
	}
	if int64(len(proof.Checksums)) != checksums.Size {
		return updateArtifact{}, errors.New("GitHub release checksum file size mismatch")
	}
	digest, count := "", 0
	for _, line := range strings.Split(proof.Checksums, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && strings.TrimPrefix(fields[1], "*") == name {
			if len(fields) != 2 || !updateDigestPattern.MatchString(fields[0]) {
				return updateArtifact{}, errors.New("invalid native release checksum")
			}
			digest, count = fields[0], count+1
		}
	}
	if count != 1 {
		return updateArtifact{}, errors.New("missing or duplicate native release checksum")
	}
	return updateArtifact{URL: asset.URL, SHA256: digest, Size: asset.Size}, nil
}

// Cached proofs are local integrity records, not publisher signatures. Their
// authority on first download is HTTPS to the fixed GitHub repository, just as
// with npm bootstrap downloads. Startup/rollback then need no network access.
func updateVerifyGitHubProof(raw []byte, target string) (updateVerifiedFeed, error) {
	var proof updateGitHubProof
	if int64(len(raw)) > updateMetadataLimit {
		return updateVerifiedFeed{}, errors.New("GitHub release proof exceeds its size limit")
	}
	if err := updateDecodeStrict(raw, &proof); err != nil {
		return updateVerifiedFeed{}, err
	}
	if proof.Repository != updateGitHubRepository || len(proof.Releases) < 1 || len(proof.Releases) > 2 {
		return updateVerifiedFeed{}, errors.New("invalid GitHub release proof repository or release count")
	}
	result := updateVerifiedFeed{Envelope: raw, Digest: updateHash(raw)}
	seen := map[string]bool{}
	for _, entry := range proof.Releases {
		artifact, err := updateGitHubArtifact(entry, target)
		if err != nil {
			return result, err
		}
		version := updateGitHubVersion(entry.Release)
		if seen[version] {
			return result, errors.New("duplicate GitHub release proof")
		}
		seen[version] = true
		parsed, _ := updateParseVersion(version)
		result.Manifest.Releases = append(result.Manifest.Releases, updateRelease{Version: version, ProtocolMajor: parsed[0], Artifacts: map[string]updateArtifact{target: artifact}})
	}
	return result, nil
}

func (manager *updateManager) githubReleases(ctx context.Context) ([]updateGitHubRelease, error) {
	if err := updateGitHubValidateEndpoints(); err != nil {
		return nil, err
	}
	releases := []updateGitHubRelease{}
	seen := map[string]bool{}
	// GitHub release ordering is not semantic version ordering. Inspect every
	// page, with a hard bound; never silently choose from an incomplete list.
	for page := 1; page <= 20; page++ {
		var buffer bytes.Buffer
		url := fmt.Sprintf("%s/releases?per_page=100&page=%d", nativeUpdateGitHubAPI, page)
		if _, err := updateDownload(ctx, manager.HTTP, url, 4*updateMetadataLimit, &buffer); err != nil {
			return nil, err
		}
		var entries []updateGitHubRelease
		if err := json.Unmarshal(buffer.Bytes(), &entries); err != nil || entries == nil || len(entries) > 100 {
			return nil, errors.New("invalid GitHub release list")
		}
		for _, entry := range entries {
			version := updateGitHubVersion(entry)
			if version == "" {
				continue
			}
			if seen[version] {
				return nil, errors.New("duplicate stable GitHub release")
			}
			seen[version] = true
			releases = append(releases, entry)
		}
		if len(entries) < 100 {
			return releases, nil
		}
	}
	return nil, errors.New("GitHub release discovery exceeded its pagination limit")
}

func (manager *updateManager) fetchGitHub(ctx context.Context, current, action, line string, supported, blocked []string) (updateVerifiedFeed, error) {
	releases, err := manager.githubReleases(ctx)
	if err != nil {
		return updateVerifiedFeed{}, err
	}
	candidates := updateVerifiedFeed{}
	for _, entry := range releases {
		parsed, _ := updateParseVersion(updateGitHubVersion(entry))
		// Defer detailed asset/checksum validation until after version selection.
		// A broken newest release must fail closed, not select an older binary.
		candidates.Manifest.Releases = append(candidates.Manifest.Releases, updateRelease{Version: updateGitHubVersion(entry), ProtocolMajor: parsed[0], Artifacts: map[string]updateArtifact{manager.Target: {}}})
	}
	pinned := ""
	if action == "repair" {
		pinned = current
	}
	selected, err := updateSelectRelease(candidates, manager.Target, current, supported, blocked, action == "install" || action == "repair", pinned, line)
	if err != nil || selected == nil {
		return updateVerifiedFeed{}, err
	}
	proof := updateGitHubProof{Repository: updateGitHubRepository}
	for _, entry := range releases {
		version := updateGitHubVersion(entry)
		if version != selected.Version && (version != current || selected.Version == current || manager.Executable == "") {
			continue
		}
		// Preserve the original binary for rollback only if it matches a
		// checksum-verified published release. Never overwrite the bootstrap.
		checksums, err := updateGitHubFindAsset(entry, "checksums.txt", updateMetadataLimit)
		if err != nil {
			return updateVerifiedFeed{}, err
		}
		var buffer bytes.Buffer
		if _, err := updateDownload(ctx, manager.HTTP, checksums.URL, checksums.Size, &buffer); err != nil {
			return updateVerifiedFeed{}, err
		}
		proof.Releases = append(proof.Releases, updateGitHubReleaseProof{Release: entry, Checksums: buffer.String()})
	}
	raw, err := json.Marshal(proof)
	if err != nil {
		return updateVerifiedFeed{}, err
	}
	return updateVerifyGitHubProof(raw, manager.Target)
}

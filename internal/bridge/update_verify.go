package bridge

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const updateMetadataLimit int64 = 1024 * 1024
const updateBinaryLimit int64 = 10_000_000 - 1

// Release builds supply these with -ldflags -X. They are deliberately not read
// from environment variables, config.json, the feed itself, or CLI arguments.
// KeysJSON is a JSON object mapping key IDs to base64 Ed25519 public keys.
var nativeUpdateFeedURL string
var nativeUpdateKeysJSON string

type updateHTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type updateTrust struct {
	FeedURL   string
	Keys      map[string]ed25519.PublicKey
	Threshold int
}

type updateSignature struct {
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

// Signed is base64 of the exact UTF-8 manifest bytes. Signatures cover those
// bytes directly, not a re-serialized JSON object or a mutable download URL.
type updateEnvelope struct {
	Signed     string            `json:"signed"`
	Signatures []updateSignature `json:"signatures"`
}

type updateManifest struct {
	SchemaVersion int             `json:"schemaVersion"`
	Channel       string          `json:"channel"`
	Sequence      uint64          `json:"sequence"`
	IssuedAt      time.Time       `json:"issuedAt"`
	ExpiresAt     time.Time       `json:"expiresAt"`
	Releases      []updateRelease `json:"releases"`
}

type updateRelease struct {
	Version       string                    `json:"version"`
	ProtocolMajor uint64                    `json:"protocolMajor"`
	Artifacts     map[string]updateArtifact `json:"artifacts"`
}

type updateArtifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type updateVerifiedFeed struct {
	Manifest updateManifest
	Envelope []byte
	Digest   string
}

var updateStableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var updateProtocolPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var updateDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var updateKeyIDPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,80}$`)

func updateParseVersion(version string) ([3]uint64, error) {
	result := [3]uint64{}
	match := updateStableVersion.FindStringSubmatch(version)
	if match == nil {
		return result, fmt.Errorf("invalid stable release version %q", version)
	}
	for i := range result {
		n, err := strconv.ParseUint(match[i+1], 10, 64)
		if err != nil {
			return result, err
		}
		result[i] = n
	}
	return result, nil
}

func updateCompareVersions(a, b string) (int, error) {
	x, err := updateParseVersion(a)
	if err != nil {
		return 0, err
	}
	y, err := updateParseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := range x {
		if x[i] < y[i] {
			return -1, nil
		}
		if x[i] > y[i] {
			return 1, nil
		}
	}
	return 0, nil
}

func updatePlatformTarget(platform, architecture string) (string, error) {
	target := "go-" + platform + "-" + architecture
	switch target {
	case "go-darwin-arm64", "go-darwin-amd64", "go-linux-arm64", "go-linux-amd64", "go-windows-amd64":
		return target, nil
	default:
		return "", fmt.Errorf("native updates are not published for %s/%s", platform, architecture)
	}
}

func updateValidateURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return errors.New("native updates require HTTPS URLs without credentials or fragments")
	}
	return nil
}

func updateValidateTrust(trust updateTrust) error {
	if err := updateValidateURL(trust.FeedURL); err != nil {
		return err
	}
	if trust.Threshold < 1 || trust.Threshold > len(trust.Keys) || len(trust.Keys) > 16 {
		return errors.New("invalid native update trust threshold")
	}
	for id, key := range trust.Keys {
		if !updateKeyIDPattern.MatchString(id) || len(key) != ed25519.PublicKeySize {
			return errors.New("invalid native update trust key")
		}
	}
	return nil
}

func updateProductionTrust() (updateTrust, error) {
	if nativeUpdateFeedURL == "" || nativeUpdateKeysJSON == "" {
		return updateTrust{}, errors.New("this build has no pinned native update feed and signing key; signed release publishing must be configured before native updates can run")
	}
	var encoded map[string]string
	if err := updateDecodeStrict([]byte(nativeUpdateKeysJSON), &encoded); err != nil {
		return updateTrust{}, fmt.Errorf("invalid compiled native update keys: %w", err)
	}
	trust := updateTrust{FeedURL: nativeUpdateFeedURL, Keys: map[string]ed25519.PublicKey{}, Threshold: 1}
	for id, raw := range encoded {
		key, err := base64.StdEncoding.Strict().DecodeString(raw)
		if err != nil {
			return trust, err
		}
		trust.Keys[id] = ed25519.PublicKey(key)
	}
	return trust, updateValidateTrust(trust)
}

func updateDecodeStrict[T interface{}](raw []byte, destination *T) error {
	if !json.Valid(raw) {
		return errors.New("invalid update JSON")
	}
	// Reject duplicate keys as well as unknown fields. Different JSON parsers
	// must not disagree about the authenticated metadata or activation state.
	if _, err := installParseJSON(string(raw)); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(destination)
}

func updateHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

func updateVerifyFeed(raw []byte, trust updateTrust, now time.Time, fresh bool) (updateVerifiedFeed, error) {
	feed := updateVerifiedFeed{}
	if err := updateValidateTrust(trust); err != nil {
		return feed, err
	}
	if int64(len(raw)) > updateMetadataLimit {
		return feed, errors.New("signed update metadata exceeds its size limit")
	}
	var envelope updateEnvelope
	if err := updateDecodeStrict(raw, &envelope); err != nil {
		return feed, err
	}
	if len(envelope.Signatures) == 0 || len(envelope.Signatures) > 16 {
		return feed, errors.New("invalid update signature count")
	}
	payload, err := base64.StdEncoding.Strict().DecodeString(envelope.Signed)
	if err != nil {
		return feed, errors.New("invalid signed update payload encoding")
	}
	verified := map[string]bool{}
	for _, signature := range envelope.Signatures {
		key, known := trust.Keys[signature.KeyID]
		if !known || verified[signature.KeyID] {
			continue
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(signature.Signature)
		if err == nil && len(decoded) == ed25519.SignatureSize && ed25519.Verify(key, payload, decoded) {
			verified[signature.KeyID] = true
		}
	}
	if len(verified) < trust.Threshold {
		return feed, errors.New("native update signature verification failed")
	}
	var manifest updateManifest
	if err := updateDecodeStrict(payload, &manifest); err != nil {
		return feed, err
	}
	if manifest.SchemaVersion != 1 || manifest.Channel != "stable" || manifest.Sequence == 0 || manifest.IssuedAt.IsZero() || manifest.ExpiresAt.IsZero() || !manifest.ExpiresAt.After(manifest.IssuedAt) || manifest.ExpiresAt.Sub(manifest.IssuedAt) > 31*24*time.Hour {
		return feed, errors.New("invalid signed update manifest header")
	}
	if fresh && (manifest.IssuedAt.After(now.Add(5*time.Minute)) || !manifest.ExpiresAt.After(now)) {
		return feed, errors.New("signed update metadata is expired or not yet valid")
	}
	if len(manifest.Releases) == 0 || len(manifest.Releases) > 128 {
		return feed, errors.New("invalid signed update release count")
	}
	seen := map[string]bool{}
	for _, release := range manifest.Releases {
		parsed, err := updateParseVersion(release.Version)
		if err != nil {
			return feed, err
		}
		if seen[release.Version] || parsed[0] != release.ProtocolMajor {
			return feed, errors.New("duplicate release or mismatched release protocol major")
		}
		seen[release.Version] = true
		if len(release.Artifacts) == 0 || len(release.Artifacts) > 16 {
			return feed, errors.New("invalid native artifact count")
		}
		for target, artifact := range release.Artifacts {
			parts := strings.Split(target, "-")
			if len(parts) != 3 || parts[0] != "go" {
				return feed, fmt.Errorf("invalid native artifact target %q", target)
			}
			if _, err := updatePlatformTarget(parts[1], parts[2]); err != nil {
				return feed, err
			}
			if !updateDigestPattern.MatchString(artifact.SHA256) || artifact.Size < 1 || artifact.Size > updateBinaryLimit {
				return feed, errors.New("invalid native artifact digest or size")
			}
			if err := updateValidateURL(artifact.URL); err != nil {
				return feed, err
			}
		}
	}
	return updateVerifiedFeed{Manifest: manifest, Envelope: append([]byte{}, raw...), Digest: updateHash(payload)}, nil
}

func updateProtocolSupported(major uint64, supported []string) bool {
	for _, protocol := range supported {
		parts := updateProtocolPattern.FindStringSubmatch(protocol)
		if parts == nil {
			continue
		}
		candidate, err := strconv.ParseUint(parts[1], 10, 64)
		if err == nil && candidate == major {
			return true
		}
	}
	return false
}

func updateSelectRelease(feed updateVerifiedFeed, target, current string, supported, blocked []string, allowEqual bool, pinned string) (*updateRelease, error) {
	if _, err := updateParseVersion(current); err != nil {
		return nil, err
	}
	var selected *updateRelease
	for _, release := range feed.Manifest.Releases {
		if pinned != "" && release.Version != pinned {
			continue
		}
		if !updateProtocolSupported(release.ProtocolMajor, supported) || installContains(blocked, release.Version) {
			continue
		}
		if _, available := release.Artifacts[target]; !available {
			continue
		}
		comparison, err := updateCompareVersions(release.Version, current)
		if err != nil {
			return nil, err
		}
		if comparison < 0 || comparison == 0 && !allowEqual {
			continue
		}
		if selected == nil {
			copy := release
			selected = &copy
		} else if newer, _ := updateCompareVersions(release.Version, selected.Version); newer > 0 {
			copy := release
			selected = &copy
		}
	}
	return selected, nil
}

func updateDefaultHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.ResponseHeaderTimeout = 15 * time.Second
	return &http.Client{Transport: transport, Timeout: 2 * time.Minute, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many native update redirects")
		}
		return updateValidateURL(request.URL.String())
	}}
}

func updateDownload(ctx context.Context, client updateHTTPClient, url string, limit int64, out io.Writer) (int64, error) {
	if err := updateValidateURL(url); err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "BrowserBridge-Native-Updater/1")
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.Request != nil && response.Request.URL != nil {
		if err := updateValidateURL(response.Request.URL.String()); err != nil {
			return 0, err
		}
	}
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("native update download returned HTTP %d", response.StatusCode)
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return 0, errors.New("compressed native update responses are not accepted")
	}
	if response.ContentLength > limit {
		return 0, errors.New("native update download exceeds its signed size limit")
	}
	written, err := io.Copy(out, io.LimitReader(response.Body, limit+1))
	if err != nil {
		return written, err
	}
	if written > limit {
		return written, errors.New("native update download exceeds its signed size limit")
	}
	return written, nil
}

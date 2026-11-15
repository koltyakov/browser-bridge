package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Inject registry operations so Windows upgrade tests never register a host
// against the developer's actual browsers.
type nativeRegistrationSystem struct {
	platform      string
	home          string
	env           func(string) string
	lookupEnv     func(string) (string, bool)
	readRegistry  func(context.Context, string) (string, error)
	writeRegistry func(context.Context, ...string) error
	userDataDir   string
}

func nativeRegistrationHostSystem() (nativeRegistrationSystem, error) {
	home, err := installUserHome()
	return nativeRegistrationSystem{
		platform: runtime.GOOS, home: home, env: os.Getenv, lookupEnv: os.LookupEnv,
		readRegistry: readNativeRegistrationRegistry, writeRegistry: installRegistry,
	}, err
}

func (s nativeRegistrationSystem) lookup(key string) (string, bool) {
	if s.lookupEnv != nil {
		return s.lookupEnv(key)
	}
	value := s.env(key)
	return value, value != ""
}

func (s nativeRegistrationSystem) candidates(c config, browser string) []string {
	definition := installBrowserByKey(browser)
	if definition == nil {
		return nil
	}
	if s.customNativeDirectory(browser) {
		return []string{filepath.Join(s.userDataDir, "NativeMessagingHosts", hostName+".json")}
	}
	legacy := filepath.Join(installLegacyManifestDir(s.platform, s.home, browser, s.env), hostName+".json")
	if s.platform == "darwin" && definition.macNativeMessagingDir != "" {
		return []string{filepath.Join(installManifestDir(s.platform, s.home, browser, s.env), hostName+".json"), legacy}
	}
	if s.platform != "windows" {
		paths := []string{filepath.Join(installManifestDir(s.platform, s.home, browser, s.env), hostName+".json")}
		// Native and Snap Chromium have independent lookup directories. Keep
		// the historical primary path, but register both when both roots exist.
		if snap := installSnapProfileDir(s.platform, s.home, browser, s.env); snap != "" && s.userDataDir == "" {
			root := installBrowserProfileDir(s.platform, s.home, browser, s.env)
			path := filepath.Join(root, "NativeMessagingHosts", hostName+".json")
			if installExists(root) && !installContains(paths, path) {
				paths = append(paths, path)
			}
		}
		return paths
	}
	return []string{filepath.Join(c.home, filepath.FromSlash(definition.windowsManifestDir), hostName+".json"), legacy}
}

const nativeRegistrationOwnersKey = "x_browser_bridge_browsers"

// Browser channels share one Windows registry key even though their profiles
// are separate. macOS browsers can explicitly share a native-host directory.
func (s nativeRegistrationSystem) registrationPeers(browser string) []string {
	if s.customNativeDirectory(browser) {
		return []string{browser}
	}
	peers := []string{}
	for _, other := range installBrowsers {
		shared := other == browser
		switch s.platform {
		case "windows":
			shared = installRegistryKey(other) == installRegistryKey(browser)
		case "darwin":
			shared = installManifestDir(s.platform, s.home, other, s.env) == installManifestDir(s.platform, s.home, browser, s.env)
		}
		if shared {
			peers = append(peers, other)
		}
	}
	if s.platform == "windows" {
		// Prefer the registry's own product over aliases that happen to be
		// earlier in the installation catalog, e.g. Chromium before Brave.
		definition := installBrowserByKey(browser)
		if definition != nil {
			parts := strings.Split(definition.registry, `\`)
			product := parts[len(parts)-1]
			for i, peer := range peers {
				if i > 0 && strings.EqualFold(peer, product) {
					peers = append([]string{peer}, append(peers[:i], peers[i+1:]...)...)
					break
				}
			}
		}
	}
	return peers
}

func (s nativeRegistrationSystem) customNativeDirectory(browser string) bool {
	definition := installBrowserByKey(browser)
	return s.userDataDir != "" && definition != nil &&
		(s.platform == "darwin" && definition.macNativeMessagingDir == "" ||
			s.platform == "linux" && definition.linuxNativeMessagingDir == "")
}

func (s nativeRegistrationSystem) sharedRegistration(browser string) bool {
	return len(s.registrationPeers(browser)) > 1
}

func (s nativeRegistrationSystem) macSharedBrowser(browser string) bool {
	return s.platform == "darwin" && s.sharedRegistration(browser)
}

func (s nativeRegistrationSystem) macSharedConsumer(browser string) bool {
	definition := installBrowserByKey(browser)
	return s.macSharedBrowser(browser) && definition != nil && definition.macNativeMessagingDir != ""
}

// Ownership is stored with the shared manifest, not in a per-install sidecar.
// An unmarked host belongs to the browser identified by its path, or the
// canonical browser for a legacy custom path. Legacy macOS registrations also
// identify consumers that uninstall must preserve.
func (s nativeRegistrationSystem) registrationOwners(c config, browser, path string, manifest object) ([]string, error) {
	if !s.sharedRegistration(browser) {
		return nil, nil
	}
	peers := s.registrationPeers(browser)
	owners := []string{}
	if raw, exists := manifest[nativeRegistrationOwnersKey]; exists {
		if err := json.Unmarshal(raw, &owners); err != nil || len(owners) == 0 {
			return nil, fmt.Errorf("invalid shared native host ownership in %s", path)
		}
		for _, owner := range owners {
			if !installContains(peers, owner) {
				return nil, fmt.Errorf("invalid shared native host owner in %s", path)
			}
		}
		return owners, nil
	}
	if s.platform == "windows" {
		for _, peer := range peers {
			for _, candidate := range s.candidates(c, peer) {
				if nativeManifestPathsEqual(candidate, path) {
					return []string{peer}, nil
				}
			}
		}
		// A legacy custom path predates channel-specific registrations.
		// Keep this inference for missing files so repair targets one owner.
		return []string{peers[0]}, nil
	}
	if installExists(path) {
		owners = append(owners, peers[0])
	}
	for _, peer := range peers {
		candidates := s.candidates(c, peer)
		if len(candidates) > 1 && installExists(candidates[1]) {
			owners = append(owners, peer)
		}
	}
	return owners, nil
}

func (s nativeRegistrationSystem) macLegacyRegistrationIssue(c config, browser string) string {
	if s.macSharedConsumer(browser) {
		paths := s.candidates(c, browser)
		if !installExists(paths[0]) && installExists(paths[1]) {
			label := strings.ToUpper(browser[:1]) + browser[1:]
			return fmt.Sprintf("%s's macOS native-host lookup uses the shared Chrome directory, not the legacy %s-only manifest; run bbx install --browser %s", label, label, browser)
		}
	}
	return ""
}

// A registered path wins even if it is missing, so diagnostics do not hide a
// broken registration behind an unrelated stale manifest. Without a registry
// entry, reuse the legacy file before creating a fresh app-owned manifest.
func (s nativeRegistrationSystem) resolve(ctx context.Context, c config, browser string) (string, string, error) {
	candidates := s.candidates(c, browser)
	if len(candidates) == 0 {
		return "", "", fmt.Errorf("unsupported browser %q", browser)
	}
	if s.platform != "windows" {
		return candidates[0], "", nil
	}
	registered, err := s.readRegistry(ctx, installRegistryKey(browser))
	if err != nil {
		return candidates[0], "", err
	}
	if registered != "" {
		absolute := filepath.IsAbs(registered) || len(registered) >= 3 && registered[1] == ':' && strings.ContainsAny(registered[2:3], `\/`) || strings.HasPrefix(registered, `\\`)
		if !absolute {
			return candidates[0], registered, errors.New("native host registry path must be absolute")
		}
		return registered, registered, nil
	}
	for i := len(candidates) - 1; i >= 0; i-- {
		if installExists(candidates[i]) {
			return candidates[i], "", nil
		}
	}
	return candidates[0], "", nil
}

// Unlike migration candidates, these are live lookup destinations. Windows
// still resolves exactly one shared registry value regardless of profile count.
func (s nativeRegistrationSystem) lookupPaths(ctx context.Context, c config, browser string) ([]string, error) {
	path, _, err := s.resolve(ctx, c, browser)
	if err != nil {
		return nil, err
	}
	if s.platform == "linux" {
		return s.candidates(c, browser), nil
	}
	return []string{path}, nil
}

func nativeManifestPathsEqual(left, right string) bool {
	normalize := func(path string) string { return filepath.Clean(strings.ReplaceAll(path, `\`, "/")) }
	return strings.EqualFold(normalize(left), normalize(right))
}

type nativeRegistrationFile struct {
	path string
	data []byte
	mode os.FileMode
}

type nativeRegistrationBackup struct {
	nativeRegistrationFile
	existed bool
}

func nativeRegistrationTransaction(files []nativeRegistrationFile, register func() error) error {
	backups := []nativeRegistrationBackup{}
	rollback := func(cause error) error {
		failures := []error{cause}
		for i := len(backups) - 1; i >= 0; i-- {
			backup := backups[i]
			var err error
			if backup.existed {
				err = installAtomicWrite(backup.path, backup.data, backup.mode)
			} else {
				err = os.Remove(backup.path)
				if errors.Is(err, os.ErrNotExist) {
					err = nil
				}
			}
			if err != nil {
				failures = append(failures, fmt.Errorf("restore %s: %w", backup.path, err))
			}
		}
		return errors.Join(failures...)
	}
	for _, file := range files {
		resolved, err := installResolveFile(file.path)
		if err != nil {
			return rollback(err)
		}
		backup := nativeRegistrationBackup{nativeRegistrationFile: nativeRegistrationFile{path: resolved, mode: file.mode}}
		backup.data, err = os.ReadFile(resolved)
		if err == nil {
			backup.existed = true
			info, statErr := os.Stat(resolved)
			if statErr != nil {
				return rollback(statErr)
			}
			backup.mode = info.Mode().Perm()
		} else if !errors.Is(err, os.ErrNotExist) {
			return rollback(err)
		}
		backups = append(backups, backup)
		if err := installAtomicWrite(file.path, file.data, file.mode); err != nil {
			return rollback(err)
		}
	}
	if err := register(); err != nil {
		return rollback(err)
	}
	return nil
}

func uninstallNativeRegistrationWithSystem(ctx context.Context, c config, browser string, system nativeRegistrationSystem) ([]string, error) {
	path, registered, err := system.resolve(ctx, c, browser)
	if err != nil {
		return nil, err
	}
	candidates := system.candidates(c, browser)
	if system.sharedRegistration(browser) {
		if data, readErr := os.ReadFile(path); readErr == nil {
			manifest, decodeErr := decodeObject(data)
			if decodeErr != nil {
				return nil, decodeErr
			}
			owners, ownerErr := system.registrationOwners(c, browser, path, manifest)
			if ownerErr != nil {
				return nil, ownerErr
			}
			// An alias that was never installed must not remove another
			// browser's host merely because both resolve to the same registry.
			if !installContains(owners, browser) {
				return nil, nil
			}
			launcher, _ := installLauncherForPlatform(c, "", system.platform)
			if manifest.text("name") != hostName || manifest.text("path") != launcher {
				return nil, fmt.Errorf("refusing to remove shared native host owned by another installation: %s", path)
			}
			remaining := []string{}
			for _, owner := range owners {
				if owner != browser {
					remaining = append(remaining, owner)
				}
			}
			if len(remaining) > 0 {
				manifest[nativeRegistrationOwnersKey] = value(remaining)
				data, err := json.MarshalIndent(manifest, "", "  ")
				if err != nil {
					return nil, err
				}
				if err := installAtomicWrite(path, append(data, '\n'), 0644); err != nil {
					return nil, err
				}
				if system.platform == "windows" {
					return nil, nil
				}
				candidates = candidates[1:]
				// A dotfile-managed shared symlink can point at the old Brave
				// file. Do not delete its target while Chrome still uses it.
				sharedTarget, err := installResolveFile(path)
				if err != nil {
					return nil, err
				}
				retained := []string{}
				for _, candidate := range candidates {
					target, err := installResolveFile(candidate)
					if err != nil {
						return nil, err
					}
					if target != sharedTarget {
						retained = append(retained, candidate)
					}
				}
				candidates = retained
			}
		} else if !errors.Is(readErr, os.ErrNotExist) {
			return nil, readErr
		}
	}
	otherRegistrations := []string{}
	if system.platform == "windows" {
		key := installRegistryKey(browser)
		seenKeys := map[string]bool{key: true}
		for _, other := range installBrowsers {
			otherKey := installRegistryKey(other)
			if seenKeys[otherKey] {
				continue
			}
			seenKeys[otherKey] = true
			reference, err := system.readRegistry(ctx, otherKey)
			if err != nil {
				return nil, err
			}
			if reference != "" {
				otherRegistrations = append(otherRegistrations, reference)
			}
		}
		// Shared-key owners were handled above, including aliases whose
		// manifest lives in the original browser's directory.
		if registered != "" {
			// Unregister before touching files. A failed registry deletion must
			// leave the still-registered native host usable.
			if err := system.writeRegistry(ctx, "delete", key, "/f"); err != nil {
				return nil, err
			}
		}
		if data, err := os.ReadFile(path); err == nil {
			if manifest, err := decodeObject(data); err == nil && manifest.text("name") == hostName {
				candidates = append(candidates, path)
			}
		}
	}
	removed := []string{}
	seen := map[string]bool{}
	for _, candidate := range candidates {
		if seen[candidate] {
			continue
		}
		seen[candidate] = true
		referenced := false
		for _, other := range otherRegistrations {
			if nativeManifestPathsEqual(candidate, other) {
				referenced = true
			}
		}
		if referenced {
			continue
		}
		if err := os.Remove(candidate); err == nil {
			removed = append(removed, candidate)
		} else if !errors.Is(err, os.ErrNotExist) {
			return removed, err
		}
	}
	return removed, nil
}

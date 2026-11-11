package bridge

import (
	"context"
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
}

func nativeRegistrationHostSystem() (nativeRegistrationSystem, error) {
	home, err := installUserHome()
	return nativeRegistrationSystem{runtime.GOOS, home, os.Getenv, os.LookupEnv, readNativeRegistrationRegistry, installRegistry}, err
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
	legacy := filepath.Join(installLegacyManifestDir(s.platform, s.home, browser, s.env), hostName+".json")
	if s.platform != "windows" {
		return []string{legacy}
	}
	return []string{filepath.Join(c.home, filepath.FromSlash(definition.windowsManifestDir), hostName+".json"), legacy}
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
		// Arc and Chromium share a registry key. Removing one browser's own
		// files must not unregister the other browser's registered manifest.
		belongsToOtherBrowser := false
		for _, other := range installBrowsers {
			if other == browser || installRegistryKey(other) != key {
				continue
			}
			for _, candidate := range system.candidates(c, other) {
				if nativeManifestPathsEqual(candidate, path) {
					belongsToOtherBrowser = true
				}
			}
		}
		if belongsToOtherBrowser {
			otherRegistrations = append(otherRegistrations, path)
		} else if registered != "" {
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

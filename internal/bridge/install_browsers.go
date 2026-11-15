package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func installDetectedBrowser(ctx context.Context, c config, browser, extensionID string, system nativeRegistrationSystem) (object, error) {
	return installNativeRegistrations(ctx, c, browser, extensionID, true, system, true)
}

func (s nativeRegistrationSystem) browserHasRegistration(ctx context.Context, c config, browser string) (bool, error) {
	path, registered, err := s.resolve(ctx, c, browser)
	if err != nil {
		return false, err
	}
	paths := []string{path}
	if s.platform == "linux" {
		paths = s.candidates(c, browser)
	}
	var failures []error
	for _, manifest := range paths {
		_, lookupErr := os.Lstat(manifest)
		if errors.Is(lookupErr, os.ErrNotExist) && s.macSharedConsumer(browser) {
			_, lookupErr = os.Lstat(s.candidates(c, browser)[1])
		}
		existing := lookupErr == nil || registered != ""
		if existing && s.sharedRegistration(browser) {
			raw, readErr := os.ReadFile(manifest)
			entry, decodeErr := decodeObject(raw)
			if readErr == nil && decodeErr == nil {
				owners, ownerErr := s.registrationOwners(c, browser, manifest, entry)
				existing = ownerErr != nil || installContains(owners, browser)
			} else if s.macSharedConsumer(browser) {
				existing = installExists(s.candidates(c, browser)[1])
			} else if s.platform == "windows" {
				owners, ownerErr := s.registrationOwners(c, browser, manifest, nil)
				existing = ownerErr != nil || installContains(owners, browser)
			}
			if s.macSharedConsumer(browser) && installExists(s.candidates(c, browser)[1]) {
				existing = true
			}
		}
		if existing {
			return true, nil
		}
		if lookupErr != nil && !errors.Is(lookupErr, os.ErrNotExist) {
			failures = append(failures, lookupErr)
		}
	}
	return false, errors.Join(failures...)
}

// Inspect only known browser profile locations and the requested extension ID.
// Browser installation alone is not a reason to register a native host, and an
// unrelated unpacked extension must not gain access by copying BBX's name.
func installDetectBrowsers(ctx context.Context, c config, extensionID string, system nativeRegistrationSystem) ([]string, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	id, explicit, err := installRequestedExtensionID(extensionID, system)
	if err != nil {
		return nil, nil, err
	}
	if browser := system.env("BBX_BROWSER"); browser != "" {
		if !installContains(installBrowsers, browser) {
			return nil, nil, fmt.Errorf("unsupported browser %q in BBX_BROWSER", browser)
		}
		return []string{browser}, nil, nil
	}
	browsers, warnings := []string{}, []string{}
	for _, browser := range installBrowsers {
		if err := ctx.Err(); err != nil {
			return nil, warnings, err
		}
		existing, lookupErr := system.browserHasRegistration(ctx, c, browser)
		if !explicit && existing {
			browsers = append(browsers, browser)
			continue
		}
		installed, profileErr := system.browserHasExtension(ctx, browser, id)
		if installed {
			browsers = append(browsers, browser)
		}
		lookupErr = errors.Join(lookupErr, profileErr)
		if lookupErr != nil {
			warnings = append(warnings, fmt.Sprintf("could not inspect %s for Browser Bridge: %v; use bbx install --browser %s to register it explicitly", browser, lookupErr, browser))
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, warnings, err
	}
	if len(browsers) == 0 {
		browsers = append(browsers, installDefaultBrowserForPlatform(system.platform))
	}
	return browsers, warnings, nil
}

func installBrowserHasExtension(ctx context.Context, root, extensionID string) (bool, error) {
	// Windows can report ReadDir(file) as PATH_NOT_FOUND. Distinguish a
	// missing profile from a malformed existing root before interpreting it.
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.IsDir() {
		return false, fmt.Errorf("browser profile root is not a directory: %s", root)
	}
	profiles, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var failures []error
	// Some Chromium browsers, including Opera, keep extension metadata
	// directly in the user-data directory instead of a Default subdirectory.
	directories := []string{root}
	for _, profile := range profiles {
		if profile.IsDir() {
			directories = append(directories, filepath.Join(root, profile.Name()))
		}
	}
	for _, directory := range directories {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		// Store installs have an extension directory. Preferences also identify
		// unpacked installs, whose source may live outside the browser profile.
		versions, readErr := os.ReadDir(filepath.Join(directory, "Extensions", extensionID))
		if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
			failures = append(failures, readErr)
		}
		for _, version := range versions {
			if !version.IsDir() {
				continue
			}
			manifest := filepath.Join(directory, "Extensions", extensionID, version.Name(), "manifest.json")
			if info, statErr := os.Stat(manifest); statErr == nil && info.Mode().IsRegular() {
				return true, nil
			} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
				failures = append(failures, statErr)
			}
		}
		for _, filename := range []string{"Preferences", "Secure Preferences"} {
			installed, readErr := installPreferencesHaveExtension(filepath.Join(directory, filename), extensionID)
			if installed {
				return true, nil
			}
			if readErr != nil {
				failures = append(failures, readErr)
			}
		}
	}
	return false, errors.Join(failures...)
}

func installPreferencesHaveExtension(path, extensionID string) (bool, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer func() { _ = file.Close() }()
	// Decode only extension registration metadata, never browser history,
	// cookies, credentials, or the contents of an unpacked extension's files.
	var preferences struct {
		Extensions struct {
			Settings map[string]json.RawMessage `json:"settings"`
		} `json:"extensions"`
	}
	if err := json.NewDecoder(io.LimitReader(file, 16<<20)).Decode(&preferences); err != nil {
		return false, fmt.Errorf("read extension registrations in %s: %w", path, err)
	}
	var registration map[string]json.RawMessage
	if err := json.Unmarshal(preferences.Extensions.Settings[extensionID], &registration); err != nil {
		return false, nil
	}
	return len(registration) > 0, nil
}

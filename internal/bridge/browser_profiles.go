package bridge

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Enumerate profile roots only. In particular, MSIX profiles do not introduce
// per-package native registrations, and fixed Unix lookups need not follow them.
func (s nativeRegistrationSystem) browserProfileRoots(browser string) ([]string, error) {
	definition := installBrowserByKey(browser)
	if definition == nil {
		return nil, fmt.Errorf("unsupported browser %q", browser)
	}
	if s.userDataDir != "" {
		return []string{s.userDataDir}, nil
	}
	root := installBrowserProfileDir(s.platform, s.home, browser, s.env)
	roots := []string{root}
	if snap := installSnapProfileDir(s.platform, s.home, browser, s.env); snap != "" && snap != root {
		roots = append(roots, snap)
	}
	if s.platform != "windows" || definition.windowsPackageFamily == "" {
		return roots, nil
	}
	local := s.env("LOCALAPPDATA")
	if local == "" {
		local = filepath.Join(s.home, "AppData", "Local")
	}
	packages := filepath.Join(local, "Packages")
	entries, err := os.ReadDir(packages)
	if errors.Is(err, os.ErrNotExist) {
		return roots, nil
	}
	if err != nil {
		return roots, fmt.Errorf("inspect browser packages in %s: %w", packages, err)
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), definition.windowsPackageFamily+"_") {
			roots = append(roots, filepath.Join(packages, entry.Name(), "LocalCache", "Local", filepath.FromSlash(definition.windowsDir)))
		}
	}
	return roots, nil
}

func installProfileRootsHaveExtension(ctx context.Context, roots []string, extensionID string) (bool, error) {
	var failures []error
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		installed, err := installBrowserHasExtension(ctx, root, extensionID)
		if installed {
			return true, nil
		}
		if err != nil {
			failures = append(failures, err)
		}
	}
	return false, errors.Join(failures...)
}

func (s nativeRegistrationSystem) browserHasExtension(ctx context.Context, browser, extensionID string) (bool, error) {
	roots, err := s.browserProfileRoots(browser)
	installed, profileErr := installProfileRootsHaveExtension(ctx, roots, extensionID)
	if installed {
		return true, nil
	}
	return false, errors.Join(err, profileErr)
}

// Only profile-relative Linux registrations have a one-to-one root mapping.
// Windows registry ownership and fixed macOS/Linux lookups remain browser-wide.
func (s nativeRegistrationSystem) profileRootsForManifest(browser, manifest string, roots []string) []string {
	if s.platform != "linux" || installBrowserByKey(browser).linuxSnapDir == "" || s.userDataDir != "" {
		return roots
	}
	selected := []string{}
	for _, root := range roots {
		if filepath.Join(root, "NativeMessagingHosts", hostName+".json") == manifest {
			selected = append(selected, root)
		}
	}
	return selected
}

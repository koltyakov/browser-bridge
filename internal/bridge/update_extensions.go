package bridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
)

func updateNewestVersion(a, b string) string {
	if _, err := updateParseVersion(b); err != nil {
		return a
	}
	if a == "" {
		return b
	}
	if comparison, err := updateCompareVersions(b, a); err == nil && comparison > 0 {
		return b
	}
	return a
}

func updateInstalledExtensionVersion(ctx context.Context, observed string) string {
	system, err := nativeRegistrationHostSystem()
	if err != nil {
		return observed
	}
	return updateExtensionVersionWithSystem(ctx, system, observed)
}

// Read only this extension's registration and manifests in known profile roots.
// Preferences select the active version; stale store directories must not raise
// the update line after an extension has been removed or disabled.
func updateExtensionVersionWithSystem(ctx context.Context, system nativeRegistrationSystem, observed string) string {
	newest := updateNewestVersion("", observed)
	id, _, err := installRequestedExtensionID("", system)
	if err != nil {
		return newest
	}
	seen := map[string]bool{}
	for _, browser := range installBrowsers {
		roots, _ := system.browserProfileRoots(browser)
		for _, root := range roots {
			if seen[root] {
				continue
			}
			seen[root] = true
			entries, _ := os.ReadDir(root)
			directories := []string{root}
			for _, entry := range entries {
				if entry.IsDir() {
					directories = append(directories, filepath.Join(root, entry.Name()))
				}
			}
			for _, directory := range directories {
				if ctx.Err() != nil {
					return newest
				}
				for _, filename := range []string{"Preferences", "Secure Preferences"} {
					newest = updateNewestVersion(newest, updateProfileExtensionVersion(directory, filename, id))
				}
			}
		}
	}
	return newest
}

func updateProfileExtensionVersion(directory, filename, id string) string {
	raw, err := updateReadRegular(filepath.Join(directory, filename), 16<<20)
	if err != nil {
		return ""
	}
	var preferences struct {
		Extensions struct {
			Settings map[string]struct {
				Path           string          `json:"path"`
				State          *int            `json:"state"`
				DisableReasons json.RawMessage `json:"disable_reasons"`
				Manifest       struct {
					Version string `json:"version"`
				} `json:"manifest"`
			} `json:"settings"`
		} `json:"extensions"`
	}
	if err := json.Unmarshal(raw, &preferences); err != nil {
		return ""
	}
	entry, exists := preferences.Extensions.Settings[id]
	if !exists || entry.State != nil && *entry.State == 0 {
		return ""
	}
	if reason := string(entry.DisableReasons); reason != "" && reason != "[]" && reason != "0" && reason != "null" {
		return ""
	}
	if entry.Path != "" {
		path := entry.Path
		if !filepath.IsAbs(path) {
			path = filepath.Join(directory, "Extensions", path)
		}
		if raw, err := updateReadRegular(filepath.Join(path, "manifest.json"), 1024*1024); err == nil {
			var manifest struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(raw, &manifest) == nil {
				return updateNewestVersion("", manifest.Version)
			}
		}
	}
	return updateNewestVersion("", entry.Manifest.Version)
}

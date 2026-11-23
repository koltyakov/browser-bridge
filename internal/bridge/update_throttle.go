package bridge

import (
	"os"
	"path/filepath"
	"time"
)

// updateCheckInterval is how often automatic native update checks run.
const updateCheckInterval = 24 * time.Hour

// updateCheckedRecently reads the update state without locking or creating
// anything and reports whether an automatic check ran within the interval.
// The CLI and MCP preflight use it to skip the daemon round trip, the
// extension health read, and the browser-profile scan on almost every call.
// A newer extension is still noticed: the native host checks when a browser
// reports its version, and the daemon checks hourly.
func updateCheckedRecently(c config, now time.Time) bool {
	if !filepath.IsAbs(c.home) {
		return false
	}
	resolved, err := filepath.EvalSymlinks(c.home)
	if err != nil {
		return false
	}
	root := filepath.Join(resolved, "native-update")
	if _, err := os.Stat(filepath.Join(root, "state.json")); err != nil {
		return false
	}
	state, err := updateLoadState(root)
	if err != nil || state.LastCheck.IsZero() {
		return false
	}
	age := now.Sub(state.LastCheck)
	return age >= 0 && age < updateCheckInterval
}

// updateNewerExtension reports whether a connected extension is newer than
// the last one an update check saw, which bypasses the throttle.
func updateNewerExtension(c config, extensionVersion string) bool {
	if extensionVersion == "" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(c.home)
	if err != nil {
		return true
	}
	state, err := updateLoadState(filepath.Join(resolved, "native-update"))
	if err != nil || state.LastExtensionVersion == "" {
		return true
	}
	comparison, err := updateCompareVersions(extensionVersion, state.LastExtensionVersion)
	return err != nil || comparison > 0
}

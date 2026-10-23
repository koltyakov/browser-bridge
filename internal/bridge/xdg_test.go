package bridge

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestXDGPathsIgnoreRelativeOverrides(t *testing.T) {
	_, scope := installTestScope(t)
	absolute := filepath.Join(scope.home, "xdg")
	for _, override := range []string{"", "relative", "~/not-expanded", absolute} {
		t.Setenv("XDG_CONFIG_HOME", override)
		t.Setenv("FLATPAK_XDG_CONFIG_HOME", "relative-flatpak")
		base := filepath.Join(scope.home, ".config")
		if override == absolute {
			base = absolute
		}
		if got := xdgDirectory(os.Getenv, "XDG_CONFIG_HOME", filepath.Join(scope.home, ".config")); got != base {
			t.Fatalf("override %q: %s", override, got)
		}
		if got := installManifestDir("linux", scope.home, "chrome", os.Getenv); got != filepath.Join(base, "google-chrome", "NativeMessagingHosts") {
			t.Fatal(got)
		}
		if got := installMuseHome(scope); got != filepath.Join(base, "muse") {
			t.Fatal(got)
		}
		if runtime.GOOS == "linux" {
			if got := installZedHome(scope); got != filepath.Join(base, "zed") {
				t.Fatal(got)
			}
			if got := installGooseHome(scope); got != filepath.Join(base, "goose") {
				t.Fatal(got)
			}
		}
	}
}

func TestLinuxBridgeHomeIgnoresRelativeXDGData(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux default data directory")
	}
	_, scope := installTestScope(t)
	t.Setenv("BROWSER_BRIDGE_HOME", "")
	for _, override := range []string{"relative", filepath.Join(scope.home, "data")} {
		t.Setenv("XDG_DATA_HOME", override)
		want := filepath.Join(scope.home, ".local", "share", "browser-bridge")
		if filepath.IsAbs(override) {
			want = filepath.Join(override, "browser-bridge")
		}
		c, err := loadConfig()
		if err != nil || c.home != want {
			t.Fatalf("override %q: %s, %v", override, c.home, err)
		}
	}
}

func TestRelativeXDGConfigDoesNotHideSnapProfile(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("XDG_CONFIG_HOME", "relative")
	snap := filepath.Join(scope.home, "snap", "chromium", "common", "chromium")
	if err := os.MkdirAll(snap, 0755); err != nil {
		t.Fatal(err)
	}
	if got := installManifestDir("linux", scope.home, "chromium", os.Getenv); got != filepath.Join(snap, "NativeMessagingHosts") {
		t.Fatal(got)
	}
}

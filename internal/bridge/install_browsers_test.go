package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func installTestBrowserProfile(system nativeRegistrationSystem, browser, profile string) string {
	return filepath.Join(filepath.Dir(installLegacyManifestDir(system.platform, system.home, browser, system.env)), profile)
}

func installTestBrowserExtension(t *testing.T, system nativeRegistrationSystem, browser, profile, id string) {
	t.Helper()
	installTestWrite(t, filepath.Join(installTestBrowserProfile(system, browser, profile), "Extensions", id, "2.1.0_0", "manifest.json"), `{"manifest_version":3,"name":"Browser Bridge","version":"2.1.0"}`)
}

func TestInstallDetectBrowsersAcrossPlatforms(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = platform
			installTestBrowserExtension(t, f.system, "chrome", "Profile 19", publishedExtensionID)
			// Unpacked and disabled extensions may exist only in preferences.
			installTestWrite(t, filepath.Join(installTestBrowserProfile(f.system, "brave", "Work"), "Secure Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"path":"/custom/bbx","state":0}}}}`)
			installTestBrowserExtension(t, f.system, "edge", "Default", strings.Repeat("a", 32))
			installTestWrite(t, filepath.Join(installTestBrowserProfile(f.system, "arc", "Default"), "Preferences"), `{"extensions":{"settings":{"unrelated":{"manifest":{"name":"Browser Bridge"}}}}}`)
			got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
			if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"chrome", "brave"}) {
				t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
			}
		})
	}
}

func TestInstallDetectBrowsersFallsBackWithoutCreatingProfiles(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = platform
			got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
			if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{installDefaultBrowserForPlatform(platform)}) {
				t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
			}
			for _, browser := range installBrowsers {
				if installExists(installTestBrowserProfile(f.system, browser, "Default")) {
					t.Fatal("discovery created a browser profile")
				}
			}
		})
	}
}

func TestInstallDetectBrowsersRepairsExistingAndBrokenRegistrations(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	f.writeManifest(t, f.system.candidates(f.config, "edge")[1], strings.Repeat("b", 32))
	f.registry[installRegistryKey("chrome")] = filepath.Join(f.system.home, "missing", "host.json")
	installTestBrowserExtension(t, f.system, "brave", "Default", publishedExtensionID)
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"chrome", "edge", "brave"}) {
		t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
	}
}

func TestInstallDetectBrowsersCustomExtensionAndBrowserOverrides(t *testing.T) {
	for _, source := range []string{"argument", "environment", "browser"} {
		t.Run(source, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			custom := strings.Repeat("c", 32)
			f.writeManifest(t, f.system.candidates(f.config, "chrome")[1], publishedExtensionID)
			installTestWrite(t, filepath.Join(installTestBrowserProfile(f.system, "brave", "Default"), "Preferences"), `{"extensions":{"settings":{"`+custom+`":{"path":"/custom/bbx"}}}}`)
			id := custom
			if source == "environment" {
				t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", custom)
				id = ""
			}
			want := []string{"brave"}
			if source == "browser" {
				t.Setenv("BBX_BROWSER", "edge")
				want = []string{"edge"}
			}
			got, warnings, err := installDetectBrowsers(context.Background(), f.config, id, f.system)
			if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, want) {
				t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
			}
		})
	}
}

func TestInstallDetectedBrowserPreservesCustomOriginsAndAddsInstalledIDs(t *testing.T) {
	for _, installed := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing-only", true: "store-also-installed"}[installed], func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			custom := strings.Repeat("d", 32)
			path := f.system.candidates(f.config, "brave")[1]
			f.writeManifest(t, path, custom)
			if installed {
				installTestBrowserExtension(t, f.system, "brave", "Default", publishedExtensionID)
			}
			for range 2 {
				if _, err := installDetectedBrowser(context.Background(), f.config, "brave", "", f.system); err != nil {
					t.Fatal(err)
				}
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			manifest, err := decodeObject(raw)
			var origins []string
			if err != nil || json.Unmarshal(manifest["allowed_origins"], &origins) != nil {
				t.Fatalf("invalid manifest: %s", raw)
			}
			want := []string{"chrome-extension://" + custom + "/"}
			if installed {
				want = append(want, "chrome-extension://"+publishedExtensionID+"/")
			}
			if !reflect.DeepEqual(origins, want) || manifest.text("userProperty") != "keep" {
				t.Fatalf("lost registration settings: %s", raw)
			}
		})
	}
}

func TestInstallExplicitExtensionWithoutStandardProfile(t *testing.T) {
	for _, preserve := range []bool{false, true} {
		t.Run(map[bool]string{false: "replace", true: "preserve"}[preserve], func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			custom := strings.Repeat("e", 32)
			path := f.system.candidates(f.config, "chrome")[1]
			f.writeManifest(t, path, publishedExtensionID)
			f.writeManifest(t, f.system.candidates(f.config, "brave")[1], publishedExtensionID)
			got, _, err := installDetectBrowsers(context.Background(), f.config, custom, f.system)
			if err != nil || !reflect.DeepEqual(got, []string{"chrome"}) {
				t.Fatalf("explicit ID did not retain the fallback browser: %v %v", got, err)
			}
			result, err := installNativeRegistrationWithSystem(context.Background(), f.config, got[0], custom, preserve, f.system)
			if err != nil {
				t.Fatal(err)
			}
			var origins []string
			if err := json.Unmarshal(result["allowedOrigins"], &origins); err != nil {
				t.Fatal(err)
			}
			want := []string{"chrome-extension://" + custom + "/"}
			if preserve {
				want = append([]string{"chrome-extension://" + publishedExtensionID + "/"}, want...)
			}
			if !reflect.DeepEqual(origins, want) {
				t.Fatalf("explicit ID was lost: %v", origins)
			}
		})
	}
}

func TestInstallDetectBrowsersRepairsDanglingManifestSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires Windows developer mode")
	}
	f := newNativeRegistrationFixture(t)
	f.system.platform = runtime.GOOS
	manifest := f.system.candidates(f.config, "edge")[0]
	if err := os.MkdirAll(filepath.Dir(manifest), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(f.system.home, "dotfiles", "edge-host.json"), manifest); err != nil {
		t.Fatal(err)
	}
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"edge"}) {
		t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
	}
	if _, err := installDetectedBrowser(context.Background(), f.config, "edge", "", f.system); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(manifest); err != nil {
		t.Fatalf("dangling manifest was not repaired: %v", err)
	}
}

func TestInstallEmptyExtensionEnvironmentIsRejectedConsistently(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", "")
	if _, _, err := installDetectBrowsers(context.Background(), f.config, "", f.system); err == nil {
		t.Fatal("automatic install accepted an empty explicit environment ID")
	}
	if _, err := installDetectedBrowser(context.Background(), f.config, "brave", "", f.system); err == nil {
		t.Fatal("self-install accepted an empty explicit environment ID")
	}
	if _, err := installNativeRegistrationWithSystem(context.Background(), f.config, "brave", "", false, f.system); err == nil {
		t.Fatal("explicit browser install accepted an empty explicit environment ID")
	}
	t.Setenv("BBX_BROWSER", "brave")
	if _, _, err := installDetectBrowsers(context.Background(), f.config, "", f.system); err == nil {
		t.Fatal("browser override bypassed environment validation")
	}
}

func TestInstallDetectBrowsersSkipsIncompleteAndMalformedProfiles(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	// Empty version directories are not installed extensions.
	if err := os.MkdirAll(filepath.Join(installTestBrowserProfile(f.system, "edge", "Default"), "Extensions", publishedExtensionID, "incomplete"), 0700); err != nil {
		t.Fatal(err)
	}
	installTestWrite(t, filepath.Join(installTestBrowserProfile(f.system, "chrome", "Default"), "Preferences"), `{"extensions":`)
	installTestBrowserExtension(t, f.system, "chrome", "Profile 2", publishedExtensionID)
	installTestWrite(t, filepath.Join(installTestBrowserProfile(f.system, "brave", "Default"), "Secure Preferences"), `{"extensions":`)
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || !reflect.DeepEqual(got, []string{"chrome"}) || len(warnings) != 1 || !strings.Contains(warnings[0], "brave") {
		t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
	}
}

func TestInstallDetectBrowsersReportsReadErrorsAndCancellation(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	f.system.readRegistry = func(_ context.Context, key string) (string, error) {
		if key == installRegistryKey("edge") {
			return "", errors.New("registry unavailable")
		}
		return "", nil
	}
	root := filepath.Dir(installLegacyManifestDir(f.system.platform, f.system.home, "brave", f.system.env))
	installTestWrite(t, root, "not a browser directory")
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(got) != 1 || len(warnings) != 2 {
		t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := installDetectBrowsers(ctx, f.config, "", f.system); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, _, err := installDetectBrowsers(context.Background(), f.config, "invalid", f.system); err == nil {
		t.Fatal("invalid extension ID accepted")
	}
	t.Setenv("BBX_BROWSER", "invalid")
	if _, _, err := installDetectBrowsers(context.Background(), f.config, "", f.system); err == nil {
		t.Fatal("invalid browser override accepted")
	}
}

func TestInstallNativeCommandAutomaticAndExplicitBrowsers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native registration changes the user's registry")
	}
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "automatic", true: "explicit"}[explicit], func(t *testing.T) {
			installTestScope(t)
			t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", publishedExtensionID)
			if err := os.Unsetenv("BROWSER_BRIDGE_EXTENSION_ID"); err != nil {
				t.Fatal(err)
			}
			c, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			// macOS cannot dial Unix sockets beneath long test directory names.
			c.address = filepath.Join(os.TempDir(), "bbx-"+uniqueID()+".sock")
			system, err := nativeRegistrationHostSystem()
			if err != nil {
				t.Fatal(err)
			}
			installTestBrowserExtension(t, system, "chrome", "Default", publishedExtensionID)
			installTestBrowserExtension(t, system, "brave", "Profile 3", publishedExtensionID)
			if !explicit {
				custom := "chrome-extension://" + strings.Repeat("f", 32) + "/"
				installTestWrite(t, system.candidates(c, "chrome")[0], string(value(object{"allowed_origins": value([]string{custom})})))
			}
			args := []string{}
			want := []string{"chrome", "brave"}
			if explicit {
				args, want = []string{"--browser", "edge"}, []string{"edge"}
				t.Setenv("BBX_BROWSER", "brave")
			}
			if err := installNativeCommand(context.Background(), c, args); err != nil {
				t.Fatal(err)
			}
			for _, browser := range installBrowsers {
				file := system.candidates(c, browser)[0]
				if installExists(file) != installContains(want, browser) {
					t.Fatalf("unexpected registration for %s", browser)
				}
			}
		})
	}
}

func TestInstallLegacyUninstallHonorsBrowserOverride(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native registration changes the user's registry")
	}
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "environment", true: "flag"}[explicit], func(t *testing.T) {
			c, _ := installTestScope(t)
			system, err := nativeRegistrationHostSystem()
			if err != nil {
				t.Fatal(err)
			}
			for _, browser := range []string{"chrome", "brave"} {
				installTestWrite(t, system.candidates(c, browser)[0], `{}`)
			}
			t.Setenv("BBX_BROWSER", "brave")
			args, removed, kept := []string{"--uninstall"}, "brave", "chrome"
			if explicit {
				args = append(args, "--browser", "chrome")
				removed, kept = "chrome", "brave"
			}
			if err := installNativeCommand(context.Background(), c, args); err != nil {
				t.Fatal(err)
			}
			if installExists(system.candidates(c, removed)[0]) || !installExists(system.candidates(c, kept)[0]) {
				t.Fatalf("uninstall did not target only %s", removed)
			}
		})
	}
}

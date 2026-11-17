package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeProfileExtension(t *testing.T, root, id string) {
	t.Helper()
	installTestWrite(t, filepath.Join(root, "Default", "Preferences"), `{"extensions":{"settings":{"`+id+`":{"state":1}}}}`)
}

func chromiumProfileFixture(t *testing.T) (nativeRegistrationFixture, string, string) {
	t.Helper()
	f := newNativeRegistrationFixture(t)
	f.system.platform = "linux"
	native := filepath.Join(f.system.home, ".config", "chromium")
	snap := filepath.Join(f.system.home, "snap", "chromium", "common", "chromium")
	for _, root := range []string{native, snap} {
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	return f, native, snap
}

func TestChromiumCoexistingProfileDiscovery(t *testing.T) {
	for _, location := range []string{"native", "snap", "both", "malformed-native"} {
		t.Run(location, func(t *testing.T) {
			f, native, snap := chromiumProfileFixture(t)
			if location == "native" || location == "both" {
				writeProfileExtension(t, native, publishedExtensionID)
			}
			if location != "native" {
				writeProfileExtension(t, snap, publishedExtensionID)
			}
			if location == "malformed-native" {
				installTestWrite(t, filepath.Join(native, "Default", "Preferences"), "{")
			}
			roots, err := f.system.browserProfileRoots("chromium")
			if err != nil || !reflect.DeepEqual(roots, []string{native, snap}) {
				t.Fatalf("roots=%v err=%v", roots, err)
			}
			// Another detected browser makes fallback-to-Chromium insufficient.
			installTestBrowserExtension(t, f.system, "edge", "Default", publishedExtensionID)
			got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
			if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"edge", "chromium"}) {
				t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
			}
			for _, root := range roots {
				if installExists(filepath.Join(root, "NativeMessagingHosts")) {
					t.Fatal("discovery created a native-host directory")
				}
			}
		})
	}
}

func TestChromiumMultiRootRegistrationPreservesIndependentOrigins(t *testing.T) {
	for _, installedRoot := range []string{"native", "snap"} {
		t.Run(installedRoot, func(t *testing.T) {
			f, native, snap := chromiumProfileFixture(t)
			custom := strings.Repeat("d", 32)
			nativeID, snapID := custom, publishedExtensionID
			profile := snap
			if installedRoot == "native" {
				nativeID, snapID, profile = publishedExtensionID, custom, native
			}
			nativeManifest := filepath.Join(native, "NativeMessagingHosts", hostName+".json")
			snapManifest := filepath.Join(snap, "NativeMessagingHosts", hostName+".json")
			f.writeManifest(t, nativeManifest, nativeID)
			f.writeManifest(t, snapManifest, snapID)
			writeProfileExtension(t, profile, publishedExtensionID)
			ctx := context.Background()
			for range 2 {
				result, err := installDetectedBrowser(ctx, f.config, "chromium", "", f.system)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(nativeRegistrationResultPaths(result), []string{snapManifest, nativeManifest}) {
					t.Fatalf("missing registration results: %s", result)
				}
			}
			for path, id := range map[string]string{nativeManifest: nativeID, snapManifest: snapID} {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				manifest, err := decodeObject(raw)
				var origins []string
				if err != nil || json.Unmarshal(manifest["allowed_origins"], &origins) != nil ||
					!reflect.DeepEqual(origins, []string{"chrome-extension://" + id + "/"}) ||
					manifest.text("userProperty") != "keep" || manifest[nativeRegistrationOwnersKey] != nil {
					t.Fatalf("mixed root origins or ownership: %s", raw)
				}
			}
			report, ids := mcpDoctorLocalWithSystem(f.config, f.system)
			if !installContains(ids, custom) || !installContains(ids, publishedExtensionID) {
				t.Fatalf("doctor ignored a lookup path: %s", report)
			}
			var entries []object
			if err := json.Unmarshal(report["browserManifests"], &entries); err != nil {
				t.Fatal(err)
			}
			var inspected []string
			for _, entry := range entries {
				if entry.text("browser") == "chromium" {
					inspected = append(inspected, entry.text("manifestPath"))
				}
			}
			if !reflect.DeepEqual(inspected, []string{snapManifest, nativeManifest}) {
				t.Fatalf("doctor lookup paths=%v", inspected)
			}
			cliEntries, valid, issues := doctorNativeManifests(ctx, f.config, f.system)
			inspected = nil
			for _, entry := range cliEntries {
				if entry.text("browser") == "chromium" {
					inspected = append(inspected, entry.text("path"))
				}
			}
			if !valid || len(issues) != 0 || !reflect.DeepEqual(inspected, []string{snapManifest, nativeManifest}) {
				t.Fatalf("CLI doctor paths=%v valid=%v issues=%v", inspected, valid, issues)
			}
			removed, err := uninstallNativeRegistrationWithSystem(ctx, f.config, "chromium", f.system)
			if err != nil || !reflect.DeepEqual(removed, []string{snapManifest, nativeManifest}) {
				t.Fatalf("removed=%v err=%v", removed, err)
			}
			// Both profile roots and their extension metadata survive uninstall.
			if !installExists(filepath.Join(profile, "Default", "Preferences")) || !installExists(native) || !installExists(snap) {
				t.Fatal("uninstall removed browser profile data")
			}
		})
	}
}

func TestChromiumDetectExistingNativeRegistrationAlongsideSnap(t *testing.T) {
	f, native, _ := chromiumProfileFixture(t)
	f.writeManifest(t, filepath.Join(native, "NativeMessagingHosts", hostName+".json"), strings.Repeat("a", 32))
	installTestBrowserExtension(t, f.system, "edge", "Default", publishedExtensionID)
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"edge", "chromium"}) {
		t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
	}
}

func TestChromiumMultiRootRegistrationPreflightsEveryManifest(t *testing.T) {
	f, native, snap := chromiumProfileFixture(t)
	nativeManifest := filepath.Join(native, "NativeMessagingHosts", hostName+".json")
	snapManifest := filepath.Join(snap, "NativeMessagingHosts", hostName+".json")
	before := f.writeManifest(t, snapManifest, strings.Repeat("a", 32))
	installTestWrite(t, nativeManifest, "{")
	launcher, _ := installLauncherForPlatform(f.config, "", "linux")
	installTestWrite(t, launcher, "unchanged launcher")
	if _, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chromium", publishedExtensionID, true, f.system); err == nil {
		t.Fatal("invalid secondary manifest accepted")
	}
	after, err := os.ReadFile(snapManifest)
	if err != nil || string(after) != string(before) {
		t.Fatal("primary manifest changed before secondary preflight completed")
	}
	data, err := os.ReadFile(launcher)
	if err != nil || string(data) != "unchanged launcher" {
		t.Fatal("launcher changed before all manifests were validated")
	}
}

func TestChromiumProfileOverridesScopeDiscoveryAndRegistration(t *testing.T) {
	for _, override := range []string{"CHROME_CONFIG_HOME", "XDG_CONFIG_HOME", "user-data-dir", "same-snap-root"} {
		t.Run(override, func(t *testing.T) {
			f, native, snap := chromiumProfileFixture(t)
			writeProfileExtension(t, native, publishedExtensionID)
			writeProfileExtension(t, snap, publishedExtensionID)
			base := filepath.Join(f.system.home, "override")
			root := filepath.Join(base, "chromium")
			switch override {
			case "user-data-dir":
				root = base
				f.system.userDataDir = root
			case "same-snap-root":
				t.Setenv("CHROME_CONFIG_HOME", filepath.Dir(snap))
				root = snap
			default:
				t.Setenv(override, base)
			}
			roots, err := f.system.browserProfileRoots("chromium")
			if err != nil || !reflect.DeepEqual(roots, []string{root}) {
				t.Fatalf("override roots=%v err=%v", roots, err)
			}
			found, err := f.system.browserHasExtension(context.Background(), "chromium", publishedExtensionID)
			if err != nil || found && override != "same-snap-root" {
				t.Fatalf("override inspected another root: found=%v err=%v", found, err)
			}
			result, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chromium", publishedExtensionID, false, f.system)
			want := filepath.Join(root, "NativeMessagingHosts", hostName+".json")
			if err != nil || !reflect.DeepEqual(nativeRegistrationResultPaths(result), []string{want}) {
				t.Fatalf("result=%s err=%v", result, err)
			}
			for _, other := range []string{native, snap} {
				if other != root && installExists(filepath.Join(other, "NativeMessagingHosts")) {
					t.Fatal("scoped install changed another profile root")
				}
			}
		})
	}
}

func TestChromiumSnapOnlyRegistrationDoesNotCreateNativeProfile(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	f.system.platform = "linux"
	snap := filepath.Join(f.system.home, "snap", "chromium", "common", "chromium")
	writeProfileExtension(t, snap, publishedExtensionID)
	result, err := installDetectedBrowser(context.Background(), f.config, "chromium", "", f.system)
	want := filepath.Join(snap, "NativeMessagingHosts", hostName+".json")
	if err != nil || !reflect.DeepEqual(nativeRegistrationResultPaths(result), []string{want}) {
		t.Fatalf("result=%s err=%v", result, err)
	}
	if installExists(filepath.Join(f.system.home, ".config", "chromium")) {
		t.Fatal("Snap-only install created a native Chromium profile")
	}
}

func TestArcMSIXProfileDiscoveryAndSharedRegistration(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	local := filepath.Join(f.system.home, "local override")
	t.Setenv("LOCALAPPDATA", local)
	standard := filepath.Join(local, "Arc", "User Data")
	roots := []string{standard}
	for index, name := range []string{"TheBrowserCompany.Arc_alpha", "TheBrowserCompany.Arc_beta"} {
		root := filepath.Join(local, "Packages", name, "LocalCache", "Local", "Arc", "User Data")
		roots = append(roots, root)
		id := publishedExtensionID
		if index == 0 {
			id = strings.Repeat("a", 32)
		}
		writeProfileExtension(t, root, id)
	}
	// Do not inspect similarly named packages, other publishers, or files.
	for _, name := range []string{"TheBrowserCompany.ArcPreview_alpha", "OtherCompany.Arc_alpha"} {
		writeProfileExtension(t, filepath.Join(local, "Packages", name, "LocalCache", "Local", "Arc", "User Data"), strings.Repeat("a", 32))
	}
	installTestWrite(t, filepath.Join(local, "Packages", "TheBrowserCompany.Arc_file"), "not a package")
	installTestWrite(t, filepath.Join(standard, "Default", "Preferences"), "{")
	gotRoots, err := f.system.browserProfileRoots("arc")
	if err != nil || !reflect.DeepEqual(gotRoots, roots) {
		t.Fatalf("roots=%v err=%v", gotRoots, err)
	}
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"arc"}) {
		t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
	}
	custom := strings.Repeat("b", 32)
	shared, err := installNativeRegistrationWithSystem(context.Background(), f.config, "brave", custom, false, f.system)
	if err != nil {
		t.Fatal(err)
	}
	writes := 0
	writeRegistry := f.system.writeRegistry
	f.system.writeRegistry = func(ctx context.Context, args ...string) error {
		writes++
		return writeRegistry(ctx, args...)
	}
	result, err := installDetectedBrowser(context.Background(), f.config, "arc", "", f.system)
	if err != nil || writes != 1 || !reflect.DeepEqual(nativeRegistrationResultPaths(result), []string{shared.text("manifestPath")}) {
		t.Fatalf("MSIX profiles changed shared registration: result=%s writes=%d err=%v", result, writes, err)
	}
	var origins []string
	if err := json.Unmarshal(result["allowedOrigins"], &origins); err != nil ||
		!reflect.DeepEqual(origins, []string{"chrome-extension://" + custom + "/", "chrome-extension://" + publishedExtensionID + "/"}) {
		t.Fatalf("shared origins lost: %s", result)
	}
	for _, root := range roots[1:] {
		if installExists(filepath.Join(root, "NativeMessagingHosts")) {
			t.Fatal("MSIX discovery introduced a per-package native registration")
		}
	}
	if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "arc", f.system); err != nil {
		t.Fatal(err)
	}
	if f.registry[installRegistryKey("chromium")] != shared.text("manifestPath") || !installExists(shared.text("manifestPath")) {
		t.Fatal("Arc uninstall removed Brave's shared registration")
	}
}

func TestProfileDiscoveryRemainsIndependentOfFixedNativeLookups(t *testing.T) {
	for _, entry := range []struct{ platform, browser string }{
		{"darwin", "brave"}, {"darwin", "opera"}, {"linux", "brave"},
	} {
		t.Run(entry.platform+"/"+entry.browser, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = entry.platform
			root := installBrowserProfileDir(entry.platform, f.system.home, entry.browser, f.system.env)
			writeProfileExtension(t, root, publishedExtensionID)
			roots, err := f.system.browserProfileRoots(entry.browser)
			if err != nil || !reflect.DeepEqual(roots, []string{root}) {
				t.Fatalf("roots=%v err=%v", roots, err)
			}
			before := f.system.candidates(f.config, entry.browser)[0]
			f.system.userDataDir = filepath.Join(f.system.home, "custom-profile")
			paths, err := f.system.lookupPaths(context.Background(), f.config, entry.browser)
			if err != nil || !reflect.DeepEqual(paths, []string{before}) {
				t.Fatalf("custom profile redirected fixed lookup: %v %v", paths, err)
			}
		})
	}
}

func TestArcCustomProfileDoesNotChangeRegistryScope(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	standardPaths := f.system.candidates(f.config, "arc")
	f.system.userDataDir = filepath.Join(f.system.home, "isolated Arc profile")
	writeProfileExtension(t, f.system.userDataDir, publishedExtensionID)
	roots, err := f.system.browserProfileRoots("arc")
	if err != nil || !reflect.DeepEqual(roots, []string{f.system.userDataDir}) {
		t.Fatalf("custom roots=%v err=%v", roots, err)
	}
	if !reflect.DeepEqual(f.system.candidates(f.config, "arc"), standardPaths) {
		t.Fatal("custom Windows profile introduced a new native-host destination")
	}
	result, err := installDetectedBrowser(context.Background(), f.config, "arc", "", f.system)
	if err != nil || f.registry[installRegistryKey("chromium")] != result.text("manifestPath") {
		t.Fatalf("result=%s err=%v", result, err)
	}
	if installExists(filepath.Join(f.system.userDataDir, "NativeMessagingHosts")) {
		t.Fatal("custom Windows profile received a profile-local manifest")
	}
}

func TestBrowserProfileDiscoveryErrorsAndCancellation(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	if _, err := f.system.browserProfileRoots("unknown"); err == nil {
		t.Fatal("unknown browser accepted")
	}
	if roots, err := f.system.browserProfileRoots("arc"); err != nil || len(roots) != 1 {
		t.Fatalf("missing packages root rejected: roots=%v err=%v", roots, err)
	}
	packages := filepath.Join(f.system.env("LOCALAPPDATA"), "Packages")
	installTestWrite(t, packages, "not a directory")
	if roots, err := f.system.browserProfileRoots("arc"); err == nil || !strings.Contains(err.Error(), "not a directory") || len(roots) != 1 {
		t.Fatalf("malformed packages root did not retain fallback roots and an error: roots=%v err=%v", roots, err)
	}
	writeProfileExtension(t, installBrowserProfileDir("windows", f.system.home, "arc", f.system.env), publishedExtensionID)
	if installed, err := f.system.browserHasExtension(context.Background(), "arc", publishedExtensionID); err != nil || !installed {
		t.Fatalf("package enumeration failure hid a matching traditional profile: %v", err)
	}
	roots, err := f.system.browserProfileRoots("chrome")
	if err != nil || len(roots) != 1 {
		t.Fatalf("unrelated browser inspected MSIX packages: %v %v", roots, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := installProfileRootsHaveExtension(ctx, []string{f.system.home}, publishedExtensionID); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

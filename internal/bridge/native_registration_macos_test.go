package bridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func macRegistrationFixture(t *testing.T) nativeRegistrationFixture {
	t.Helper()
	f := newNativeRegistrationFixture(t)
	f.system.platform = "darwin"
	return f
}

func macWriteManifest(t *testing.T, f nativeRegistrationFixture, path string, ids ...string) []byte {
	t.Helper()
	launcher, _ := installLauncherForPlatform(f.config, "", "darwin")
	installTestWrite(t, launcher, "#!/bin/sh\n")
	if err := os.Chmod(launcher, 0755); err != nil {
		t.Fatal(err)
	}
	origins := []string{}
	for _, id := range ids {
		origins = append(origins, "chrome-extension://"+id+"/")
	}
	data := value(object{"name": value(hostName), "description": value("Browser Bridge native host"), "type": value("stdio"), "path": value(launcher), "allowed_origins": value(origins), "userProperty": value("keep")})
	installTestWrite(t, path, string(data))
	return data
}

func TestMacBraveOnlyManifestIsNotDiscoverableUntilRepaired(t *testing.T) {
	f := macRegistrationFixture(t)
	paths := f.system.candidates(f.config, "brave")
	chrome := f.system.candidates(f.config, "chrome")[0]
	if paths[0] != chrome || paths[1] == chrome {
		t.Fatal("Brave must share Chrome's lookup but retain its legacy migration path", paths)
	}
	custom := strings.Repeat("a", 32)
	original := macWriteManifest(t, f, paths[1], custom)
	// This fixture mirrors M2018's healthy local installation with a valid
	// Brave-only file. It models the upstream lookup; it is not a real Brave.
	path, _, err := f.system.resolve(context.Background(), f.config, "brave")
	if err != nil || path != chrome || installExists(path) {
		t.Fatal("the obsolete file hid the native-host discovery failure", path, err)
	}
	report, ids := mcpDoctorLocalWithSystem(f.config, f.system)
	if report.boolean("manifestInstalled") || len(ids) != 0 || !strings.Contains(string(report["nativeHostManifestIssues"]), "manifest_lookup_mismatch") {
		t.Fatal("doctor treated an undiscoverable Brave-only file as usable", report)
	}
	browsers, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(browsers, []string{"brave"}) {
		t.Fatal("update/repair did not detect the obsolete registration", browsers, warnings, err)
	}
	for range 2 {
		result, err := installDetectedBrowser(context.Background(), f.config, "brave", "", f.system)
		if err != nil || result.text("manifestPath") != chrome {
			t.Fatal(result, err)
		}
	}
	raw, _ := os.ReadFile(chrome)
	manifest, _ := decodeObject(raw)
	if manifest.text("userProperty") != "keep" || !strings.Contains(string(manifest["allowed_origins"]), custom) {
		t.Fatal("migration lost custom manifest settings", manifest)
	}
	if raw, _ := os.ReadFile(paths[1]); string(raw) != string(original) {
		t.Fatal("repair overwrote the old Brave-only registration")
	}
	report, ids = mcpDoctorLocalWithSystem(f.config, f.system)
	if !report.boolean("manifestInstalled") || !reflect.DeepEqual(ids, []string{custom}) || string(report["nativeHostManifestIssues"]) != "[]" {
		t.Fatal("doctor did not recognize the repaired shared registration", report, ids)
	}
	browsers, _, err = installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || !reflect.DeepEqual(browsers, []string{"brave"}) {
		t.Fatal("a Brave-only repair incorrectly registered Chrome as a consumer", browsers, err)
	}
}

func TestMacSharedNativeRegistrationPreservesBothBrowsers(t *testing.T) {
	for _, first := range []string{"chrome", "brave"} {
		for _, remove := range []string{"chrome", "brave"} {
			t.Run(first+"/remove-"+remove, func(t *testing.T) {
				f := macRegistrationFixture(t)
				other := map[string]string{"chrome": "brave", "brave": "chrome"}
				custom := strings.Repeat("b", 32)
				ctx := context.Background()
				if _, err := installNativeRegistrationWithSystem(ctx, f.config, first, custom, false, f.system); err != nil {
					t.Fatal(err)
				}
				result, err := installNativeRegistrationWithSystem(ctx, f.config, other[first], publishedExtensionID, false, f.system)
				if err != nil {
					t.Fatal(err)
				}
				var origins []string
				if err := json.Unmarshal(result["allowedOrigins"], &origins); err != nil || len(origins) != 2 {
					t.Fatal("single-browser install revoked shared origins", result, err)
				}
				path := result.text("manifestPath")
				for range 2 {
					// Repeated scoped uninstalls must leave the other consumer.
					if _, err := uninstallNativeRegistrationWithSystem(ctx, f.config, remove, f.system); err != nil || !installExists(path) {
						t.Fatal("uninstall broke the other browser", err)
					}
				}
				if _, err := installDetectedBrowser(ctx, f.config, other[remove], "", f.system); err != nil {
					t.Fatal("repair broke the remaining registration", err)
				}
				if _, err := uninstallNativeRegistrationWithSystem(ctx, f.config, other[remove], f.system); err != nil || installExists(path) {
					t.Fatal("last consumer did not remove the shared registration", err)
				}
			})
		}
	}
}

func TestMacBraveMigrationKeepsExistingChromeSettings(t *testing.T) {
	f := macRegistrationFixture(t)
	paths := f.system.candidates(f.config, "brave")
	chromeID, braveID := strings.Repeat("c", 32), strings.Repeat("d", 32)
	macWriteManifest(t, f, paths[0], chromeID)
	macWriteManifest(t, f, paths[1], braveID)
	result, err := installDetectedBrowser(context.Background(), f.config, "brave", "", f.system)
	if err != nil {
		t.Fatal(err)
	}
	var origins []string
	_ = json.Unmarshal(result["allowedOrigins"], &origins)
	if !reflect.DeepEqual(origins, []string{"chrome-extension://" + chromeID + "/", "chrome-extension://" + braveID + "/"}) {
		t.Fatal("Chrome or legacy Brave origin was lost", origins)
	}
	removed, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "brave", f.system)
	if err != nil || !reflect.DeepEqual(removed, []string{paths[1]}) || !installExists(paths[0]) {
		t.Fatal("Brave uninstall removed Chrome's shared registration", removed, err)
	}
}

func TestMacAutoRepairFindsLegacyBraveBesideManagedChrome(t *testing.T) {
	f := macRegistrationFixture(t)
	if _, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome", publishedExtensionID, false, f.system); err != nil {
		t.Fatal(err)
	}
	got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"chrome"}) {
		t.Fatal("a Chrome-only manifest was mistaken for a registered Brave consumer", got, warnings, err)
	}
	macWriteManifest(t, f, f.system.candidates(f.config, "brave")[1], strings.Repeat("f", 32))
	got, warnings, err = installDetectBrowsers(context.Background(), f.config, "", f.system)
	if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"chrome", "brave"}) {
		t.Fatal("Chrome's ownership marker hid the legacy Brave registration", got, warnings, err)
	}
}

func TestMacBraveRegistrationRefusesToClobberSharedHost(t *testing.T) {
	for _, kind := range []string{"different-home", "invalid-json", "invalid-owners", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			f := macRegistrationFixture(t)
			paths := f.system.candidates(f.config, "brave")
			original := macWriteManifest(t, f, paths[0], strings.Repeat("e", 32))
			switch kind {
			case "different-home":
				entry, _ := decodeObject(original)
				entry["path"] = value(filepath.Join(f.system.home, "another-install", "launcher.sh"))
				original = value(entry)
				installTestWrite(t, paths[0], string(original))
			case "invalid-json":
				original = []byte("{broken")
				installTestWrite(t, paths[0], string(original))
			case "invalid-owners":
				entry, _ := decodeObject(original)
				entry[macRegistrationOwnersKey] = value([]string{"unknown"})
				original = value(entry)
				installTestWrite(t, paths[0], string(original))
			case "symlink":
				target := filepath.Join(t.TempDir(), "shared.json")
				entry, _ := decodeObject(original)
				entry["path"] = value("/another/launcher.sh")
				original = value(entry)
				installTestWrite(t, target, string(original))
				if err := os.Remove(paths[0]); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, paths[0]); err != nil {
					t.Skip("symlinks unavailable:", err)
				}
			}
			launcher, _ := installLauncherForPlatform(f.config, "", "darwin")
			before, _ := os.ReadFile(launcher)
			if _, err := installNativeRegistrationWithSystem(context.Background(), f.config, "brave", publishedExtensionID, false, f.system); err == nil {
				t.Fatal("overwrote a conflicting shared registration")
			}
			after, _ := os.ReadFile(launcher)
			data, _ := os.ReadFile(paths[0])
			if string(data) != string(original) || string(before) != string(after) {
				t.Fatal("failed registration changed the shared manifest or launcher")
			}
		})
	}
}

func TestMacBraveProfilesDoNotUseChromeRegistrationDirectory(t *testing.T) {
	f := macRegistrationFixture(t)
	installTestBrowserExtension(t, f.system, "brave", "Default", publishedExtensionID)
	got, _, err := installDetectBrowsers(context.Background(), f.config, publishedExtensionID, f.system)
	if err != nil || !reflect.DeepEqual(got, []string{"brave"}) {
		t.Fatal("manifest alias changed browser profile detection", got, err)
	}
}

func TestMacUnmarkedSharedRegistrationUninstallKeepsOtherConsumer(t *testing.T) {
	for _, remove := range []string{"chrome", "brave"} {
		t.Run(remove, func(t *testing.T) {
			f := macRegistrationFixture(t)
			paths := f.system.candidates(f.config, "brave")
			macWriteManifest(t, f, paths[0], publishedExtensionID)
			macWriteManifest(t, f, paths[1], publishedExtensionID)
			if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, remove, f.system); err != nil || !installExists(paths[0]) {
				t.Fatal("legacy unmarked shared registration was deleted", err)
			}
			other := map[string]string{"chrome": "brave", "brave": "chrome"}[remove]
			if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, other, f.system); err != nil || installExists(paths[0]) {
				t.Fatal("last unmarked consumer was not cleaned up", err)
			}
		})
	}
}

func TestMacSharedSymlinkUninstallPreservesItsLegacyTarget(t *testing.T) {
	f := macRegistrationFixture(t)
	paths := f.system.candidates(f.config, "brave")
	macWriteManifest(t, f, paths[1], publishedExtensionID)
	if err := os.MkdirAll(filepath.Dir(paths[0]), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(paths[1], paths[0]); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "brave", f.system); err != nil || !installExists(paths[0]) || !installExists(paths[1]) {
		t.Fatal("Brave uninstall deleted Chrome's symlink target", err)
	}
}

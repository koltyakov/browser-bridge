package bridge

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUpdateNewestInstalledExtensionAcrossBrowsersAndPlatforms(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = platform
			profile := func(browser, name string) string {
				return installTestBrowserProfile(f.system, browser, name)
			}
			installTestWrite(t, filepath.Join(profile("chrome", "Default"), "Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"manifest":{"version":"2.2.1"}}}}}`)
			installTestWrite(t, filepath.Join(profile("edge", "Work"), "Secure Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"manifest":{"version":"2.3.0"}}}}}`)
			// Disabled, unrelated, invalid and orphaned versions cannot raise the line.
			installTestWrite(t, filepath.Join(profile("brave", "Default"), "Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"manifest":{"version":"9.0.0"},"disable_reasons":[1]}}}}`)
			installTestWrite(t, filepath.Join(profile("chrome", "Other"), "Preferences"), `{"extensions":{"settings":{"unrelated":{"manifest":{"name":"Browser Bridge","version":"10.0.0"}}}}}`)
			installTestWrite(t, filepath.Join(profile("chrome", "Orphan"), "Extensions", publishedExtensionID, "99.0.0_0", "manifest.json"), `{"version":"99.0.0"}`)
			installTestWrite(t, filepath.Join(profile("chrome", "Invalid"), "Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"manifest":{"version":"invalid"}}}}}`)
			if got := updateExtensionVersionWithSystem(context.Background(), f.system, "2.1.0"); got != "2.3.0" {
				t.Fatal("did not select newest installed browser extension", got)
			}
			if got := updateExtensionVersionWithSystem(context.Background(), f.system, "2.4.0"); got != "2.4.0" {
				t.Fatal("ignored newer native identity", got)
			}
		})
	}
}

func TestNativeUpdateStatusReportsInstalledExtensionForReadOnlyBootstrapDiscovery(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	f.system.platform = runtime.GOOS
	profile := installTestBrowserProfile(f.system, "chrome", "Default")
	installTestWrite(t, filepath.Join(profile, "Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"manifest":{"version":"2.3.0"}}}}}`)
	status, err := nativeUpdateStatus(f.config)
	if err != nil || status.text("installedExtensionVersion") != "2.3.0" || status.text("updateLine") != "2.3.x" {
		t.Fatal(status, err)
	}
	if _, err := os.Stat(f.config.home); !os.IsNotExist(err) {
		t.Fatal("read-only status created installation state", err)
	}
}

func TestUpdateExtensionUsesRegisteredManifestAndRootProfiles(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	f.system.platform = "linux"
	root := installBrowserProfileDir(f.system.platform, f.system.home, "opera", f.system.env)
	unpacked := filepath.Join(f.system.home, "unpacked-bbx")
	installTestWrite(t, filepath.Join(unpacked, "manifest.json"), `{"version":"2.3.1"}`)
	// The registered metadata can lag behind the unpacked manifest after update.
	installTestWrite(t, filepath.Join(root, "Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"path":"`+filepath.ToSlash(unpacked)+`","manifest":{"version":"2.2.1"}}}}}`)
	if got := updateExtensionVersionWithSystem(context.Background(), f.system, ""); got != "2.3.1" {
		t.Fatal(got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := updateExtensionVersionWithSystem(ctx, f.system, "2.1.0"); got != "2.1.0" {
		t.Fatal("ignored cancellation", got)
	}
}

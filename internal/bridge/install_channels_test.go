package bridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestInstallChromeChannelPaths(t *testing.T) {
	home := t.TempDir()
	env := func(string) string { return "" }
	channels := []struct {
		key, mac, windows, linux string
	}{
		{"chrome", "Chrome", "Chrome", "google-chrome"},
		{"chrome-beta", "Chrome Beta", "Chrome Beta", "google-chrome-beta"},
		{"chrome-dev", "Chrome Dev", "Chrome Dev", "google-chrome-unstable"},
		{"chrome-canary", "Chrome Canary", "Chrome SxS", "google-chrome-canary"},
		{"chrome-for-testing", "Chrome for Testing", "Chrome for Testing", "google-chrome-for-testing"},
	}
	for _, channel := range channels {
		t.Run(channel.key, func(t *testing.T) {
			want := filepath.Join(home, "Library", "Application Support", "Google", channel.mac, "NativeMessagingHosts")
			if got := installManifestDir("darwin", home, channel.key, env); got != want {
				t.Fatalf("macOS manifest: %s != %s", got, want)
			}
			want = filepath.Join(home, "AppData", "Local", "Google", channel.windows, "User Data", "NativeMessagingHosts")
			if got := installLegacyManifestDir("windows", home, channel.key, env); got != want {
				t.Fatalf("Windows profile: %s != %s", got, want)
			}
			want = filepath.Join(home, ".config", channel.linux, "NativeMessagingHosts")
			if got := installManifestDir("linux", home, channel.key, env); got != want {
				t.Fatalf("Linux manifest: %s != %s", got, want)
			}
			registryBrowser := "chrome"
			if channel.key == "chrome-for-testing" {
				registryBrowser = "chromium"
			}
			if installRegistryKey(channel.key) != installRegistryKey(registryBrowser) {
				t.Fatal("Windows Chrome channels must share Chrome's native-host registry key")
			}
		})
	}
}

func TestWindowsChromiumBasedBrowsersUsePrimaryLookupKey(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	for _, browser := range []string{"brave", "arc", "chrome-for-testing", "vivaldi", "opera"} {
		if installRegistryKey(browser) != installRegistryKey("chromium") {
			t.Fatalf("%s must register the Chromium key, which takes precedence over Chrome's fallback", browser)
		}
		peers := f.system.registrationPeers(browser)
		if len(peers) == 0 || peers[0] != "chromium" {
			t.Fatalf("legacy custom host ownership must default to Chromium, not an alias: %v", peers)
		}
	}
}

func TestInstallDetectChromeCanaryWithoutStableChrome(t *testing.T) {
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = platform
			var root string
			switch platform {
			case "darwin":
				root = filepath.Join(f.system.home, "Library", "Application Support", "Google", "Chrome Canary")
			case "windows":
				root = filepath.Join(f.system.home, "AppData", "Local", "Google", "Chrome SxS", "User Data")
			default:
				root = filepath.Join(f.system.home, ".config", "google-chrome-canary")
			}
			installTestWrite(t, filepath.Join(root, "Profile 2", "Extensions", publishedExtensionID, "2.1.2_0", "manifest.json"), `{"manifest_version":3}`)
			got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
			if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"chrome-canary"}) {
				t.Fatalf("browsers=%v warnings=%v err=%v", got, warnings, err)
			}
		})
	}
}

func TestWindowsChromeChannelsShareRegistrationAndPreserveOwners(t *testing.T) {
	for _, first := range []string{"chrome", "chrome-canary"} {
		t.Run(first, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			second := "chrome"
			if first == second {
				second = "chrome-canary"
			}
			custom := strings.Repeat("c", 32)
			initial, err := installNativeRegistrationWithSystem(context.Background(), f.config, first, custom, false, f.system)
			if err != nil {
				t.Fatal(err)
			}
			shared, err := installNativeRegistrationWithSystem(context.Background(), f.config, second, publishedExtensionID, false, f.system)
			if err != nil || shared.text("manifestPath") != initial.text("manifestPath") {
				t.Fatalf("channels did not reuse one registered manifest: %s %v", shared, err)
			}
			var origins []string
			if err := json.Unmarshal(shared["allowedOrigins"], &origins); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(origins, []string{"chrome-extension://" + custom + "/", "chrome-extension://" + publishedExtensionID + "/"}) {
				t.Fatalf("lost another channel's origin: %v", origins)
			}
			got, warnings, err := installDetectBrowsers(context.Background(), f.config, "", f.system)
			if err != nil || len(warnings) != 0 || !reflect.DeepEqual(got, []string{"chrome", "chrome-canary"}) {
				t.Fatalf("shared key falsely detected other channels: %v %v %v", got, warnings, err)
			}
			for _, owner := range []string{first, second} {
				if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, owner, f.system); err != nil {
					t.Fatal(err)
				}
				remaining := owner == first
				if installExists(initial.text("manifestPath")) != remaining || (f.registry[installRegistryKey("chrome")] != "") != remaining {
					t.Fatalf("uninstall of %s did not preserve exactly the remaining consumers", owner)
				}
			}
		})
	}
}

func TestWindowsUnregisteredChannelDoesNotRemoveChrome(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	result, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome", publishedExtensionID, false, f.system)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "chrome-beta", f.system); err != nil {
		t.Fatal(err)
	}
	if !installExists(result.text("manifestPath")) || f.registry[installRegistryKey("chrome")] == "" {
		t.Fatal("uninstalling an unregistered channel removed Chrome's host")
	}
}

func TestWindowsSharedPrimaryMigrationPreservesPerBrowserOrigins(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	shared := f.system.candidates(f.config, "chromium")[0]
	primaryID, previousID := strings.Repeat("d", 32), strings.Repeat("e", 32)
	f.writeManifest(t, shared, primaryID)
	f.registry[installRegistryKey("chromium")] = shared
	f.writeManifest(t, f.system.candidates(f.config, "brave")[0], previousID)
	result, err := installNativeRegistrationWithSystem(context.Background(), f.config, "brave", publishedExtensionID, false, f.system)
	if err != nil {
		t.Fatal(err)
	}
	var origins []string
	if err := json.Unmarshal(result["allowedOrigins"], &origins); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{primaryID, previousID, publishedExtensionID} {
		if !installContains(origins, "chrome-extension://"+id+"/") {
			t.Fatalf("shared registry migration lost %s: %v", id, origins)
		}
	}
}

func TestInstallCustomUserDataDirectoryIsIndependent(t *testing.T) {
	for _, platform := range []string{"darwin", "linux"} {
		t.Run(platform, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = platform
			standard, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome-canary", publishedExtensionID, false, f.system)
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(standard.text("manifestPath"))
			if err != nil {
				t.Fatal(err)
			}
			f.system.userDataDir = filepath.Join(f.system.home, "developer profiles", "canary")
			custom, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome-canary", publishedExtensionID, false, f.system)
			want := filepath.Join(f.system.userDataDir, "NativeMessagingHosts", hostName+".json")
			if err != nil || custom.text("manifestPath") != want {
				t.Fatalf("custom manifest: %s %v", custom, err)
			}
			if f.system.browserProfileRoot("chrome-canary") != f.system.userDataDir {
				t.Fatal("custom extension discovery ignored the requested user-data directory")
			}
			if _, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "chrome-canary", f.system); err != nil {
				t.Fatal(err)
			}
			after, err := os.ReadFile(standard.text("manifestPath"))
			if err != nil || string(before) != string(after) || installExists(want) {
				t.Fatal("custom uninstall changed the standard registration or retained the custom manifest")
			}
		})
	}
}

func TestInstallCustomUserDataDirectoryArgumentValidation(t *testing.T) {
	for _, args := range [][]string{
		{"--user-data-dir"},
		{"--user-data-dir="},
		{"--user-data-dir", ""},
		{"--user-data-dir", "profile"},
		{"--user-data-dir", "profile", "--browser", "chrome", "--all"},
		{"--user-data-dir", "profile", "--browser", "chrome", "--browser", "chrome-canary"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			c, _ := installTestScope(t)
			if err := installNativeCommand(context.Background(), c, args); err == nil {
				t.Fatal("ambiguous user-data directory arguments were accepted")
			}
		})
	}
}

func TestInstallDetectExtensionInRootProfile(t *testing.T) {
	root := t.TempDir()
	installTestWrite(t, filepath.Join(root, "Preferences"), `{"extensions":{"settings":{"`+publishedExtensionID+`":{"state":1}}}}`)
	found, err := installBrowserHasExtension(context.Background(), root, publishedExtensionID)
	if err != nil || !found {
		t.Fatalf("root-level extension registration was missed: %v", err)
	}
}

func TestInstallOperaUsesRoamingProfileAndSharedMacHost(t *testing.T) {
	home := t.TempDir()
	for _, configured := range []bool{false, true} {
		env := func(key string) string {
			if configured && key == "APPDATA" {
				return filepath.Join(home, "roaming-override")
			}
			return ""
		}
		base := filepath.Join(home, "AppData", "Roaming")
		if configured {
			base = env("APPDATA")
		}
		want := filepath.Join(base, "Opera Software", "Opera Stable", "NativeMessagingHosts")
		if got := installLegacyManifestDir("windows", home, "opera", env); got != want {
			t.Fatalf("Opera profile must use roaming application data: %s != %s", got, want)
		}
		if installManifestDir("darwin", home, "opera", env) != installManifestDir("darwin", home, "chrome", env) {
			t.Fatal("Opera's macOS native host must use Chrome's lookup directory")
		}
	}
}

func TestInstallFixedNativeLookupWithCustomProfile(t *testing.T) {
	for _, entry := range []struct{ platform, browser string }{
		{"darwin", "brave"}, {"darwin", "opera"}, {"linux", "brave"},
	} {
		t.Run(entry.platform+"/"+entry.browser, func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			f.system.platform = entry.platform
			standard := f.system.candidates(f.config, entry.browser)[0]
			f.system.userDataDir = filepath.Join(f.system.home, "custom-profile")
			if got := f.system.candidates(f.config, entry.browser)[0]; got != standard {
				t.Fatalf("fixed native lookup incorrectly followed --user-data-dir: %s", got)
			}
			if f.system.browserProfileRoot(entry.browser) != f.system.userDataDir {
				t.Fatal("extension discovery must still inspect the custom browser profile")
			}
		})
	}
}

func TestInstallCustomUserDataDirectoryCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("real registry writes are covered through the injected Windows system")
	}
	installTestScope(t)
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	c.address = filepath.Join(os.TempDir(), "bbx-"+uniqueID()+".sock")
	directory := filepath.Join(t.TempDir(), "custom-profile")
	args := []string{publishedExtensionID, "--browser", "chrome-canary", "--user-data-dir=" + directory}
	if err := installNativeCommand(context.Background(), c, args); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(directory, "NativeMessagingHosts", hostName+".json")
	if !installExists(manifest) {
		t.Fatal("CLI did not register the custom user-data directory")
	}
	if err := installNativeCommand(context.Background(), c, []string{"--uninstall", "--browser", "chrome-canary", "--user-data-dir", directory}); err != nil {
		t.Fatal(err)
	}
	if installExists(manifest) {
		t.Fatal("CLI did not uninstall the custom registration")
	}
}

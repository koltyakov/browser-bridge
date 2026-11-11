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

type nativeRegistrationFixture struct {
	config   config
	system   nativeRegistrationSystem
	registry map[string]string
}

func newNativeRegistrationFixture(t *testing.T) nativeRegistrationFixture {
	t.Helper()
	c, scope := installTestScope(t)
	t.Setenv("BROWSER_BRIDGE_EXTENSION_ID", publishedExtensionID)
	if err := os.Unsetenv("BROWSER_BRIDGE_EXTENSION_ID"); err != nil {
		t.Fatal(err)
	}
	entries := map[string]string{}
	system := nativeRegistrationSystem{
		platform: "windows", home: scope.home, env: os.Getenv, lookupEnv: os.LookupEnv,
		readRegistry: func(_ context.Context, key string) (string, error) { return entries[key], nil },
		writeRegistry: func(_ context.Context, args ...string) error {
			switch args[0] {
			case "add":
				for i, arg := range args {
					if arg == "/d" {
						entries[args[1]] = args[i+1]
						return nil
					}
				}
			case "delete":
				delete(entries, args[1])
				return nil
			}
			return errors.New("unexpected registry operation")
		},
	}
	return nativeRegistrationFixture{c, system, entries}
}

func (f nativeRegistrationFixture) writeManifest(t *testing.T, path string, ids ...string) []byte {
	t.Helper()
	launcher := filepath.Join(f.config.home, "native-host-launcher.cmd")
	installTestWrite(t, launcher, "existing Node launcher\r\n")
	origins := []string{}
	for _, id := range ids {
		origins = append(origins, "chrome-extension://"+id+"/")
	}
	data := value(object{"name": value(hostName), "path": value(launcher), "type": value("stdio"), "allowed_origins": value(origins), "userProperty": value("keep")})
	installTestWrite(t, path, string(data))
	return data
}

func TestWindowsNativeRegistrationFreshBrowserPaths(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	seen := map[string]bool{}
	for _, browser := range []string{"chrome", "edge", "brave"} {
		result, err := installNativeRegistrationWithSystem(context.Background(), f.config, browser, publishedExtensionID, false, f.system)
		if err != nil {
			t.Fatal(err)
		}
		path := result.text("manifestPath")
		want := filepath.Join(f.config.home, "NativeMessagingHosts", browser, hostName+".json")
		if path != want || seen[path] || f.registry[installRegistryKey(browser)] != path {
			t.Fatalf("wrong browser registration: %s", result)
		}
		seen[path] = true
		if installExists(f.system.candidates(f.config, browser)[1]) {
			t.Fatal("fresh install created a legacy browser directory")
		}
	}
}

func TestWindowsNativeRegistrationPreservesLegacyNodeInstall(t *testing.T) {
	for _, registered := range []bool{false, true} {
		t.Run(map[bool]string{false: "unregistered", true: "registered"}[registered], func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			paths := f.system.candidates(f.config, "chrome")
			custom := strings.Repeat("a", 32)
			f.writeManifest(t, paths[1], custom, publishedExtensionID)
			if registered {
				f.registry[installRegistryKey("chrome")] = paths[1]
				f.writeManifest(t, paths[0], publishedExtensionID)
			}
			result, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome", "", false, f.system)
			if err != nil {
				t.Fatal(err)
			}
			if result.text("manifestPath") != paths[1] || result.text("extensionId") != custom || f.registry[installRegistryKey("chrome")] != paths[1] {
				t.Fatal(result)
			}
			data, _ := os.ReadFile(paths[1])
			manifest, _ := decodeObject(data)
			var origins []string
			_ = json.Unmarshal(manifest["allowed_origins"], &origins)
			if manifest.text("userProperty") != "keep" || len(origins) != 2 || origins[0] != "chrome-extension://"+custom+"/" {
				t.Fatal("lost legacy manifest properties or custom extension origins")
			}
		})
	}
}

func TestWindowsNativeRegistrationHonorsCustomRegisteredPath(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	path := filepath.Join(f.system.home, "custom", hostName+".json")
	custom := strings.Repeat("b", 32)
	f.writeManifest(t, path, custom)
	f.registry[installRegistryKey("chrome")] = path
	result, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome", "", true, f.system)
	if err != nil || result.text("manifestPath") != path || result.text("extensionId") != custom {
		t.Fatal(result, err)
	}
}

func TestWindowsNativeRegistrationRollsBackFailedRegistryWrite(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	path := f.system.candidates(f.config, "chrome")[1]
	original := f.writeManifest(t, path, strings.Repeat("a", 32))
	launcher := filepath.Join(f.config.home, "native-host-launcher.cmd")
	f.registry[installRegistryKey("chrome")] = path
	denied := errors.New("registry write denied")
	f.system.writeRegistry = func(context.Context, ...string) error {
		if !installExists(path) {
			t.Fatal("removed the registered manifest before registration completed")
		}
		return denied
	}
	_, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome", publishedExtensionID, false, f.system)
	if !errors.Is(err, denied) {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	launcherData, _ := os.ReadFile(launcher)
	if string(data) != string(original) || string(launcherData) != "existing Node launcher\r\n" || f.registry[installRegistryKey("chrome")] != path {
		t.Fatal("failed registration changed the working legacy installation")
	}
}

func TestWindowsNativeRegistrationReplacementRetainsOldFile(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	paths := f.system.candidates(f.config, "chrome")
	original := f.writeManifest(t, paths[1], strings.Repeat("a", 32))
	for _, succeed := range []bool{false, true} {
		err := nativeRegistrationTransaction([]nativeRegistrationFile{{paths[0], []byte("replacement"), 0644}}, func() error {
			if data, _ := os.ReadFile(paths[1]); string(data) != string(original) || !installExists(paths[0]) {
				t.Fatal("replacement was registered before being written, or old manifest was removed")
			}
			if !succeed {
				return errors.New("registration denied")
			}
			return nil
		})
		if (err == nil) != succeed || installExists(paths[0]) != succeed || !installExists(paths[1]) {
			t.Fatal("unsafe replacement state", err)
		}
	}
}

func TestWindowsNativeRegistrationWriteFailureRestoresEarlierFiles(t *testing.T) {
	root := t.TempDir()
	launcher := filepath.Join(root, "launcher.cmd")
	installTestWrite(t, launcher, "old")
	blocked := filepath.Join(root, "not-a-directory")
	installTestWrite(t, blocked, "file")
	err := nativeRegistrationTransaction([]nativeRegistrationFile{{launcher, []byte("new"), 0755}, {filepath.Join(blocked, "manifest.json"), []byte("{}"), 0644}}, func() error {
		t.Fatal("registered after file write failed")
		return nil
	})
	data, _ := os.ReadFile(launcher)
	if err == nil || string(data) != "old" {
		t.Fatal("failed transaction did not restore launcher", err)
	}
}

func TestWindowsNativeUninstallBothLayoutsKeepsOtherBrowser(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	chrome := f.system.candidates(f.config, "chrome")
	edge := f.system.candidates(f.config, "edge")[0]
	f.writeManifest(t, chrome[0], publishedExtensionID)
	f.writeManifest(t, chrome[1], publishedExtensionID)
	edgeData := f.writeManifest(t, edge, publishedExtensionID)
	f.registry[installRegistryKey("chrome")], f.registry[installRegistryKey("edge")] = chrome[1], edge
	removed, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "chrome", f.system)
	if err != nil || len(removed) != 2 || f.registry[installRegistryKey("chrome")] != "" || f.registry[installRegistryKey("edge")] != edge {
		t.Fatal(removed, err)
	}
	data, _ := os.ReadFile(edge)
	if string(data) != string(edgeData) || !installExists(filepath.Join(f.config.home, "native-host-launcher.cmd")) {
		t.Fatal("uninstall broke another browser")
	}
}

func TestWindowsNativeUninstallFailureLeavesRegisteredFiles(t *testing.T) {
	for _, query := range []bool{false, true} {
		t.Run(map[bool]string{false: "delete", true: "query"}[query], func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			path := f.system.candidates(f.config, "chrome")[1]
			original := f.writeManifest(t, path, publishedExtensionID)
			f.registry[installRegistryKey("chrome")] = path
			denied := errors.New("registry denied")
			if query {
				read := f.system.readRegistry
				f.system.readRegistry = func(ctx context.Context, key string) (string, error) {
					if key == installRegistryKey("edge") {
						return "", denied
					}
					return read(ctx, key)
				}
			} else {
				f.system.writeRegistry = func(context.Context, ...string) error { return denied }
			}
			_, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, "chrome", f.system)
			data, _ := os.ReadFile(path)
			if !errors.Is(err, denied) || string(data) != string(original) || f.registry[installRegistryKey("chrome")] != path {
				t.Fatal("failed unregistration damaged the installed host", err)
			}
		})
	}
}

func TestWindowsNativeUninstallSharedReferencesAndRegistryAlias(t *testing.T) {
	for _, alias := range []bool{false, true} {
		t.Run(map[bool]string{false: "shared file", true: "Arc Chromium alias"}[alias], func(t *testing.T) {
			f := newNativeRegistrationFixture(t)
			browser, other := "chrome", "edge"
			if alias {
				browser, other = "arc", "chromium"
			}
			path := f.system.candidates(f.config, other)[0]
			f.writeManifest(t, path, publishedExtensionID)
			f.registry[installRegistryKey(browser)], f.registry[installRegistryKey(other)] = path, path
			_, err := uninstallNativeRegistrationWithSystem(context.Background(), f.config, browser, f.system)
			if err != nil || !installExists(path) || f.registry[installRegistryKey(other)] != path {
				t.Fatal("removed another browser's host", err)
			}
			if !alias && f.registry[installRegistryKey(browser)] != "" {
				t.Fatal("did not remove selected browser registration")
			}
			_, err = uninstallNativeRegistrationWithSystem(context.Background(), f.config, other, f.system)
			if err != nil || installExists(path) || len(f.registry) != 0 {
				t.Fatal("last registration was not removed", err)
			}
		})
	}
}

func TestWindowsNativeDiagnosticsBothLayoutsAndRegisteredPrecedence(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	browser := installDefaultBrowser()
	paths := f.system.candidates(f.config, browser)
	custom := strings.Repeat("a", 32)
	f.writeManifest(t, paths[1], custom)
	f.writeManifest(t, paths[0], publishedExtensionID)
	f.registry[installRegistryKey(browser)] = paths[1]
	report, ids := mcpDoctorLocalWithSystem(f.config, f.system)
	if report.text("manifestPath") != paths[1] || !report.boolean("manifestInstalled") || !reflect.DeepEqual(ids, []string{custom}) {
		t.Fatal(report, ids)
	}
	f.registry[installRegistryKey(browser)] = paths[0]
	report, ids = mcpDoctorLocalWithSystem(f.config, f.system)
	if report.text("manifestPath") != paths[0] || !reflect.DeepEqual(ids, []string{publishedExtensionID}) {
		t.Fatal(report, ids)
	}
	if err := os.Remove(paths[0]); err != nil {
		t.Fatal(err)
	}
	report, _ = mcpDoctorLocalWithSystem(f.config, f.system)
	if report.boolean("manifestInstalled") {
		t.Fatal("stale legacy manifest hid missing registered target")
	}
}

func TestWindowsNativeRegistryErrorsDoNotModifyFiles(t *testing.T) {
	f := newNativeRegistrationFixture(t)
	path := f.system.candidates(f.config, "chrome")[1]
	original := f.writeManifest(t, path, publishedExtensionID)
	f.system.readRegistry = func(context.Context, string) (string, error) { return "", errors.New("registry query denied") }
	if _, err := installNativeRegistrationWithSystem(context.Background(), f.config, "chrome", "", false, f.system); err == nil {
		t.Fatal("ignored registry access failure")
	}
	data, _ := os.ReadFile(path)
	if string(data) != string(original) {
		t.Fatal("query failure modified legacy manifest")
	}
}

package bridge

import (
	"encoding/json"
	"os"
	"testing"
)

func TestInstallRegistryMatchesCanonicalSource(t *testing.T) {
	data, err := os.ReadFile("../../protocol/install-targets.json")
	if err != nil {
		t.Fatal(err)
	}
	var source struct {
		HostName       string                                                         `json:"hostName"`
		ExtensionID    string                                                         `json:"extensionId"`
		MaxBinaryBytes int64                                                          `json:"maxBinaryBytes"`
		Platforms      []struct{ Key, GOOS, GOARCH, Asset string }                    `json:"platforms"`
		Browsers       []struct{ Key, MacDir, WindowsDir, LinuxDir, Registry string } `json:"browsers"`
	}
	if err := json.Unmarshal(data, &source); err != nil {
		t.Fatal(err)
	}
	if source.HostName != hostName || source.ExtensionID != publishedExtensionID || source.MaxBinaryBytes != nativeMaxBytes || len(source.Platforms) != len(nativePlatformRegistry) || len(source.Browsers) != len(browserRegistry) {
		t.Fatal("generated installation metadata drifted")
	}
	for i, platform := range source.Platforms {
		got := nativePlatformRegistry[i]
		if got.key != platform.Key || got.goos != platform.GOOS || got.goarch != platform.GOARCH || got.asset != platform.Asset {
			t.Fatal("platform drift", platform.Key)
		}
		if target, err := updatePlatformTarget(platform.GOOS, platform.GOARCH); err != nil || target != "go-"+platform.GOOS+"-"+platform.GOARCH {
			t.Fatal("updater target drift", target, err)
		}
	}
	for i, browser := range source.Browsers {
		got := installBrowserByKey(browser.Key)
		if got == nil || installBrowsers[i] != browser.Key || got.macDir != browser.MacDir || got.windowsDir != browser.WindowsDir || got.linuxDir != browser.LinuxDir || got.registry != browser.Registry {
			t.Fatal("browser drift", browser.Key)
		}
	}
	if installManifestDir("linux", "/unused", "unknown", func(string) string { return "" }) != "" || installRegistryKey("unknown") != "" {
		t.Fatal("unknown browser resolved to a user directory")
	}
}

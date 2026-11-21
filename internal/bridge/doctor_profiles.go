package bridge

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// customProfileBrowser is a running browser started with an explicit
// --user-data-dir. On Linux and macOS such a browser reads user-level native
// host manifests from <user-data-dir>/NativeMessagingHosts, not from the
// default profile root where `bbx install` registers.
type customProfileBrowser struct {
	browser     string
	userDataDir string
}

// browserExecutableKeys maps an executable name fragment to the install key
// used by `bbx install --browser`.
var browserExecutableKeys = []struct{ fragment, key string }{
	{"chromium", "chromium"},
	{"brave", "brave"},
	{"msedge", "edge"},
	{"microsoft edge", "edge"},
	{"vivaldi", "vivaldi"},
	{"chrome", "chrome"},
}

func browserKeyForExecutable(executable string) string {
	base := strings.ToLower(filepath.Base(executable))
	for _, entry := range browserExecutableKeys {
		if strings.Contains(base, entry.fragment) {
			return entry.key
		}
	}
	return ""
}

// parseBrowserProfileArgs returns the browser and user-data-dir of a
// top-level browser process, or false for helpers and other programs.
func parseBrowserProfileArgs(args []string) (customProfileBrowser, bool) {
	if len(args) == 0 {
		return customProfileBrowser{}, false
	}
	key := browserKeyForExecutable(args[0])
	if key == "" {
		return customProfileBrowser{}, false
	}
	dir := ""
	for i, arg := range args[1:] {
		if strings.HasPrefix(arg, "--type=") {
			return customProfileBrowser{}, false
		}
		if value, ok := strings.CutPrefix(arg, "--user-data-dir="); ok {
			dir = value
		} else if arg == "--user-data-dir" && i+2 < len(args) {
			dir = args[i+2]
		}
	}
	if dir == "" {
		return customProfileBrowser{}, false
	}
	return customProfileBrowser{browser: key, userDataDir: filepath.Clean(dir)}, true
}

// linuxBrowserProfiles reads exact argument vectors from /proc.
func linuxBrowserProfiles(procRoot string) []customProfileBrowser {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil
	}
	found := []customProfileBrowser{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.Trim(entry.Name(), "0123456789") != "" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procRoot, entry.Name(), "cmdline"))
		if err != nil || len(raw) == 0 {
			continue
		}
		args := strings.Split(string(bytes.TrimRight(raw, "\x00")), "\x00")
		// Chrome rewrites its process title, leaving one space-joined string
		// instead of separate arguments. A path containing spaces is then
		// not recognized.
		if len(args) == 1 {
			args = strings.Fields(args[0])
		}
		if profile, ok := parseBrowserProfileArgs(args); ok {
			found = append(found, profile)
		}
	}
	return found
}

var psUserDataDir = regexp.MustCompile(`--user-data-dir=(\S+)`)

// darwinBrowserProfiles parses `ps` output. Arguments are space-joined there,
// so a user-data-dir containing spaces is not recognized.
func darwinBrowserProfiles(ctx context.Context) []customProfileBrowser {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-axww", "-o", "command=").Output()
	if err != nil {
		return nil
	}
	found := []customProfileBrowser{}
	for line := range strings.SplitSeq(string(out), "\n") {
		if strings.Contains(line, "--type=") {
			continue
		}
		match := psUserDataDir.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		executable := line[:strings.Index(line, match[0])]
		if key := browserKeyForExecutable(strings.TrimSpace(executable)); key != "" {
			found = append(found, customProfileBrowser{browser: key, userDataDir: filepath.Clean(match[1])})
		}
	}
	return found
}

// customProfileRegistrationWarnings names running browsers whose explicit
// user-data-dir has no Browser Bridge native host manifest.
func customProfileRegistrationWarnings(profiles []customProfileBrowser) []string {
	seen := map[string]bool{}
	warnings := []string{}
	for _, profile := range profiles {
		if seen[profile.userDataDir] {
			continue
		}
		seen[profile.userDataDir] = true
		manifest := filepath.Join(profile.userDataDir, "NativeMessagingHosts", hostName+".json")
		if _, err := os.Stat(manifest); err == nil {
			continue
		}
		warnings = append(warnings, fmt.Sprintf("A running %s uses --user-data-dir %s, which reads native hosts from %s; Browser Bridge is not registered there, so that browser cannot connect. Run `bbx install --browser %s --user-data-dir %s`.", profile.browser, profile.userDataDir, filepath.Dir(manifest), profile.browser, profile.userDataDir))
	}
	sort.Strings(warnings)
	return warnings
}

func doctorCustomProfileWarnings(ctx context.Context) []string {
	switch runtime.GOOS {
	case "linux":
		return customProfileRegistrationWarnings(linuxBrowserProfiles("/proc"))
	case "darwin":
		return customProfileRegistrationWarnings(darwinBrowserProfiles(ctx))
	}
	return nil
}

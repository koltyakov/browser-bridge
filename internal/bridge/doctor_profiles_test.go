package bridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseBrowserProfileArgsKeepsTopLevelBrowsers(t *testing.T) {
	for _, tc := range []struct {
		args    []string
		browser string
		dir     string
	}{
		{[]string{"/opt/google/chrome/chrome", "--user-data-dir=/home/a/p", "about:blank"}, "chrome", "/home/a/p"},
		{[]string{"/usr/bin/chromium", "--user-data-dir", "/tmp/c"}, "chromium", "/tmp/c"},
		{[]string{"/opt/google/chrome/chrome", "--type=renderer", "--user-data-dir=/home/a/p"}, "", ""},
		{[]string{"/opt/google/chrome/chrome", "about:blank"}, "", ""},
		{[]string{"/usr/bin/python3", "--user-data-dir=/x"}, "", ""},
	} {
		got, ok := parseBrowserProfileArgs(tc.args)
		// The parser cleans paths with the host's rules; Windows turns /home/a/p
		// into \home\a\p, so compare against the same cleaning.
		want := tc.dir
		if want != "" {
			want = filepath.Clean(want)
		}
		if ok != (tc.browser != "") || got.browser != tc.browser || got.userDataDir != want {
			t.Errorf("%v => %+v %v", tc.args, got, ok)
		}
	}
}

func TestCustomProfileWarningsNameUnregisteredDirectories(t *testing.T) {
	proc := t.TempDir()
	registered, missing := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(registered, "NativeMessagingHosts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(registered, "NativeMessagingHosts", hostName+".json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(proc, "104"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Chrome's rewritten process title: one space-joined string, no NULs.
	retitled := t.TempDir()
	if err := os.WriteFile(filepath.Join(proc, "104", "cmdline"), []byte("/opt/google/chrome/chrome --user-data-dir="+retitled+" --no-first-run about:blank"), 0o600); err != nil {
		t.Fatal(err)
	}
	for pid, args := range map[string][]string{
		"101":  {"/opt/google/chrome/chrome", "--user-data-dir=" + registered},
		"102":  {"/opt/google/chrome/chrome", "--user-data-dir=" + missing},
		"103":  {"/opt/google/chrome/chrome", "--type=gpu-process", "--user-data-dir=" + missing},
		"self": {"/opt/google/chrome/chrome", "--user-data-dir=/ignored"},
	} {
		if err := os.MkdirAll(filepath.Join(proc, pid), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(proc, pid, "cmdline"), []byte(strings.Join(args, "\x00")+"\x00"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	warnings := customProfileRegistrationWarnings(linuxBrowserProfiles(proc))
	joined := strings.Join(warnings, "\n")
	if len(warnings) != 2 || !strings.Contains(joined, "--user-data-dir "+missing+"`") || !strings.Contains(joined, "--user-data-dir "+retitled+"`") || !strings.Contains(joined, "--browser chrome") {
		t.Fatalf("warnings: %q", warnings)
	}
}

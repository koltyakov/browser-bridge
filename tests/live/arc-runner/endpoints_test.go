package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testEndpoint = "ws://127.0.0.1:49308/devtools/browser/bb8b1dc0-02e8-45ab-9c98-ab44dce9bd8b"

func endpointFixture(t *testing.T, oldLog string) launchSources {
	t.Helper()
	root := t.TempDir()
	log := filepath.Join(root, "browser.log")
	writeTestFile(t, log, oldLog)
	sources, err := captureSources(root, log, []string{
		filepath.Join(root, "requested-profile"),
		filepath.Join(root, "home", "Library", "Application Support", "Arc", "User Data"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return sources
}

func writeTestFile(t *testing.T, file, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func appendLog(t *testing.T, sources launchSources, text string) {
	t.Helper()
	file, err := os.OpenFile(sources.logPath, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, writeErr := file.WriteString(text)
	if err := file.Close(); err != nil || writeErr != nil {
		t.Fatalf("write=%v close=%v", writeErr, err)
	}
}

func writePort(t *testing.T, profile string) {
	t.Helper()
	writeTestFile(t, filepath.Join(profile, "DevToolsActivePort"), "49308\n/devtools/browser/bb8b1dc0-02e8-45ab-9c98-ab44dce9bd8b")
}

func TestArcFreshLogEndpointUsesActualIsolatedHome(t *testing.T) {
	sources := endpointFixture(t, "old log\n")
	appendLog(t, sources, "\nDevTools listening on "+testEndpoint+"\n")
	writePort(t, sources.profiles[1])
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	selected, err := sources.discover(ctx)
	if err != nil || selected.URL != testEndpoint || selected.Source != "startup_log" {
		t.Fatalf("endpoint=%+v err=%v", selected, err)
	}
	proof, err := sources.verifyIsolation(ctx, selected)
	if err != nil || proof.Profile != sources.profiles[1] {
		t.Fatalf("proof=%+v err=%v", proof, err)
	}
	if _, err := os.Stat(sources.profiles[0]); !os.IsNotExist(err) {
		t.Fatal("runner created or used the ignored requested profile")
	}
}

func TestArcDiscoveryIgnoresPrelaunchLogAndPortFile(t *testing.T) {
	sources := endpointFixture(t, "DevTools listening on "+testEndpoint+"\n")
	writePort(t, sources.profiles[0])
	var err error
	sources, err = captureSources(sources.root, sources.logPath, sources.profiles)
	if err != nil {
		t.Fatal(err)
	}
	// Touching a preexisting port file does not make it launch-owned.
	writePort(t, sources.profiles[0])
	value, err := sources.freshLogEndpoint()
	if err != nil || value != "" {
		t.Fatalf("stale log was accepted: %q %v", value, err)
	}
	ports, err := sources.freshPorts()
	if err != nil || len(ports) != 0 {
		t.Fatalf("stale port file was accepted: %v %v", ports, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if _, err := sources.discover(ctx); err == nil {
		t.Fatal("stale sources passed discovery")
	}
}

func TestArcStartupLogOnlyAcceptsCompletedFreshEndpointLines(t *testing.T) {
	sources := endpointFixture(t, "DevTools listening on "+testEndpoint+"\n")
	appendLog(t, sources, "DevTools listening on "+testEndpoint)
	if value, err := sources.freshLogEndpoint(); err != nil || value != "" {
		t.Fatalf("partial line accepted: %q %v", value, err)
	}
	appendLog(t, sources, "\n")
	if value, err := sources.freshLogEndpoint(); err != nil || value != testEndpoint {
		t.Fatalf("completed line missed: %q %v", value, err)
	}
}

func TestArcDiscoveryRetainsFreshPortFileFallback(t *testing.T) {
	sources := endpointFixture(t, "")
	writePort(t, sources.profiles[0])
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	selected, err := sources.discover(ctx)
	if err != nil || selected.Source != "port_file" {
		t.Fatalf("endpoint=%+v err=%v", selected, err)
	}
	if _, err := sources.verifyIsolation(ctx, selected); err != nil {
		t.Fatal(err)
	}
}

func TestArcLogWithoutIsolatedPortProofDoesNotAuthorizeConnection(t *testing.T) {
	sources := endpointFixture(t, "")
	appendLog(t, sources, "DevTools listening on "+testEndpoint+"\n")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	selected, err := sources.discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sources.verifyIsolation(ctx, selected); err == nil || !strings.Contains(err.Error(), "isolation") {
		t.Fatalf("log announcement alone proved isolation: %v", err)
	}
}

func TestArcRejectsMismatchedAndEscapingPortProof(t *testing.T) {
	t.Run("mismatch", func(t *testing.T) {
		sources := endpointFixture(t, "")
		writePort(t, sources.profiles[0])
		selected := endpoint{strings.Replace(testEndpoint, "49308", "49309", 1), "startup_log"}
		if _, err := sources.verifyIsolation(context.Background(), selected); err == nil {
			t.Fatal("different browser endpoint passed isolation")
		}
	})
	t.Run("conflicting secondary profile", func(t *testing.T) {
		sources := endpointFixture(t, "")
		writePort(t, sources.profiles[0])
		writeTestFile(t, filepath.Join(sources.profiles[1], "DevToolsActivePort"), "49309\n/devtools/browser/other")
		if _, err := sources.verifyIsolation(context.Background(), endpoint{testEndpoint, "startup_log"}); err == nil {
			t.Fatal("a matching primary file hid a conflicting secondary profile")
		}
	})
	t.Run("symlink escape", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks require developer mode")
		}
		sources := endpointFixture(t, "")
		outside := t.TempDir()
		writePort(t, outside)
		if err := os.Symlink(outside, sources.profiles[0]); err != nil {
			t.Fatal(err)
		}
		if _, err := sources.verifyIsolation(context.Background(), endpoint{testEndpoint, "startup_log"}); err == nil {
			t.Fatal("external profile symlink passed isolation")
		}
	})
	t.Run("outside root", func(t *testing.T) {
		sources := endpointFixture(t, "")
		outside := t.TempDir()
		sources.profiles = []string{outside}
		writePort(t, outside)
		if _, err := sources.freshPorts(); err == nil {
			t.Fatal("external default profile was accepted")
		}
	})
}

func TestArcRejectsReplacedTruncatedAndAmbiguousStartupLogs(t *testing.T) {
	for _, mode := range []string{"replaced", "truncated", "ambiguous"} {
		t.Run(mode, func(t *testing.T) {
			sources := endpointFixture(t, "prelaunch data\n")
			switch mode {
			case "replaced":
				if err := os.Rename(sources.logPath, sources.logPath+".old"); err != nil {
					t.Fatal(err)
				}
				writeTestFile(t, sources.logPath, "DevTools listening on "+testEndpoint+"\n")
			case "truncated":
				writeTestFile(t, sources.logPath, "")
			case "ambiguous":
				appendLog(t, sources, "DevTools listening on "+testEndpoint+"\nDevTools listening on "+strings.Replace(testEndpoint, "49308", "49309", 1)+"\n")
			}
			if _, err := sources.freshLogEndpoint(); err == nil {
				t.Fatal("untrusted log change accepted")
			}
		})
	}
}

func TestArcEndpointParsingRejectsUnsafeTargets(t *testing.T) {
	for _, value := range []string{
		"ws://example.com:49308/devtools/browser/a",
		"ws://localhost:49308/devtools/browser/a",
		"wss://127.0.0.1:49308/devtools/browser/a",
		"ws://user@127.0.0.1:49308/devtools/browser/a",
		testEndpoint + "?token=x", testEndpoint + "?", testEndpoint + "#fragment",
		"ws://127.0.0.1:0/devtools/browser/a",
		"ws://127.0.0.1:65536/devtools/browser/a",
		"ws://127.0.0.1:49308/devtools/page/a",
		"ws://127.0.0.1:49308/devtools/browser/a/other",
		"ws://127.0.0.1:49308/devtools/browser/%61",
	} {
		if _, err := parseEndpoint(value); err == nil {
			t.Errorf("unsafe endpoint accepted: %s", value)
		}
	}
	if _, err := parsePortFile([]byte("49308\n")); err == nil {
		t.Fatal("incomplete port file accepted")
	}
}

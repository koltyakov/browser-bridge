package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDaemonCommandUsesStableWorkingDirectory(t *testing.T) {
	staging := filepath.Join(t.TempDir(), "npm-staging")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	t.Chdir(staging)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name          string
		relativeHome  bool
		relativeToken bool
	}{
		{name: "absolute"},
		{name: "relative token", relativeToken: true},
		{name: "relative home", relativeHome: true, relativeToken: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "bridge")
			token := filepath.Join(t.TempDir(), "agent.auth")
			if tt.relativeHome {
				home = "bridge"
			}
			if tt.relativeToken {
				token = "agent.auth"
			}
			absoluteHome, err := filepath.Abs(home)
			if err != nil {
				t.Fatal(err)
			}
			absoluteToken, err := filepath.Abs(token)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(absoluteHome, 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("BROWSER_BRIDGE_HOME", home)
			t.Setenv("BBX_AUTH_TOKEN_FILE", token)
			t.Setenv("BBX_DAEMON_CWD_HELPER", "1")
			c, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			cmd, err := daemonCommand(c, executable)
			if err != nil {
				t.Fatal(err)
			}
			wantCWD, wantCommandDir, wantToken := absoluteHome, absoluteHome, absoluteToken
			if tt.relativeHome {
				wantCWD, wantCommandDir, wantToken = staging, "", token
			}
			if cmd.Dir != wantCommandDir || strings.Join(cmd.Args[1:], " ") != "--bridge-daemon" {
				t.Fatalf("unexpected daemon command: dir=%q args=%q", cmd.Dir, cmd.Args)
			}
			cmd.Args = []string{executable, "-test.run=^TestDaemonCommandWorkingDirectoryHelper$"}
			output, err := cmd.Output()
			if err != nil {
				t.Fatal(err)
			}
			var observed struct{ CWD, Home, Token, Address string }
			if err := json.Unmarshal(output, &observed); err != nil {
				t.Fatal(err)
			}
			// macOS can canonicalize /var to /private/var in os.Getwd.
			wantDirectory, err := filepath.EvalSymlinks(wantCWD)
			if err != nil {
				t.Fatal(err)
			}
			observedDirectory, err := filepath.EvalSymlinks(observed.CWD)
			if err != nil {
				t.Fatal(err)
			}
			if observedDirectory != wantDirectory || observed.Home != home || observed.Token != wantToken || observed.Address != c.address {
				t.Fatalf("daemon inherited staging paths: %+v", observed)
			}
		})
	}
}

func TestDaemonCommandWorkingDirectoryHelper(t *testing.T) {
	if os.Getenv("BBX_DAEMON_CWD_HELPER") != "1" {
		return
	}
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct{ CWD, Home, Token, Address string }{
		directory, os.Getenv("BROWSER_BRIDGE_HOME"), os.Getenv("BBX_AUTH_TOKEN_FILE"), c.address,
	}); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}

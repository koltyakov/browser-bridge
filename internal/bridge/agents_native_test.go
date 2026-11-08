package bridge

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPRepairableWrapperCommands(t *testing.T) {
	_, scope := installTestScope(t)
	path := installMCPPath("claude", scope)
	previous := filepath.Join(scope.home, "old-release", "bbx")
	installTestWrite(t, previous, "existing older executable")
	for _, test := range []struct {
		name   string
		launch []string
		want   bool
	}{
		{"bare command", []string{"bbx", "mcp", "serve"}, true},
		{"older native release", []string{previous, "mcp", "serve"}, true},
		{"npm shim", []string{filepath.Join(scope.home, "npm", "bbx.cmd"), "mcp", "serve"}, true},
		{"MCP alias", []string{"bbx-mcp.cmd"}, true},
		{"npx", []string{"npx", "-y", "@browserbridge/bbx@1.0.0", "mcp", "serve"}, true},
		{"npm exec", []string{"npm", "exec", "--package=@browserbridge/bbx", "--", "bbx", "mcp", "serve"}, true},
		{"Node MCP entry", []string{"node", filepath.Join(scope.home, "packages", "npm", "bin", "bbx-mcp.js")}, true},
		{"Node CLI entry", []string{"node", filepath.Join(scope.home, "packages", "npm", "bin", "bbx.js"), "mcp", "serve"}, true},
		{"native", []string{installTestBinary(t), "mcp", "serve"}, false},
		{"custom wrapper", []string{"my-wrapper.sh", "mcp", "serve"}, false},
		{"other npm package", []string{"npx", "@example/server", "mcp", "serve"}, false},
		{"custom Node script", []string{"node", filepath.Join(scope.home, "custom.js")}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			entry := object{"command": value(test.launch[0]), "args": value(test.launch[1:])}
			raw := string(value(object{"mcpServers": value(object{"browser-bridge": value(entry)})}))
			if got := installMCPRepairable(raw, "claude", path, scope); got != test.want {
				t.Fatalf("repairable = %v, want %v: %s", got, test.want, raw)
			}
		})
	}
}

func TestRepairMCPReplacesExistingWrappers(t *testing.T) {
	_, scope := installTestScope(t)
	t.Setenv("PATH", t.TempDir())
	configs := map[string]string{
		"claude":   `{"mcpServers":{"browser-bridge":{"command":"npx","args":["-y","@browserbridge/bbx","mcp","serve"],"env":{"KEEP":"value"},"disabled":true}}}`,
		"opencode": `{"mcp":{"browser-bridge":{"type":"local","command":["npm","exec","--package=@browserbridge/bbx","--","bbx","mcp","serve"],"environment":{"KEEP":"value"},"enabled":false}}}`,
		"codex":    "[mcp_servers.browser-bridge]\ncommand = \"bbx\"\nargs = [\"mcp\", \"serve\"]\nenabled = false\n[mcp_servers.browser-bridge.env]\nKEEP = \"value\"\n",
		"goose":    "extensions:\n  browser-bridge:\n    type: stdio\n    cmd: npx\n    args: ['@browserbridge/bbx', mcp, serve]\n    enabled: false\n    envs: {KEEP: value}\n",
	}
	for client, raw := range configs {
		installTestWrite(t, installMCPPath(client, scope), raw)
	}
	repaired, failed := installRepairStaleMCP(context.Background())
	if len(failed) != 0 || len(repaired) != len(configs) {
		t.Fatalf("repair results: %v, failures: %v", repaired, failed)
	}
	for client := range configs {
		path := installMCPPath(client, scope)
		raw := mustRead(t, path)
		launch := installMCPLaunchStrings(raw, client, path, scope)
		if len(launch) != 3 || launch[0] != installTestBinary(t) || launch[1] != "mcp" || launch[2] != "serve" {
			t.Fatalf("%s still uses a wrapper: %v", client, launch)
		}
		if !strings.Contains(raw, "KEEP") || !strings.Contains(raw, "false") && !strings.Contains(raw, `"disabled":true`) {
			t.Fatalf("lost user settings: %s", raw)
		}
	}
	if repaired, failed := installRepairStaleMCP(context.Background()); len(repaired) != 0 || len(failed) != 0 {
		t.Fatalf("repair must be idempotent: %v %v", repaired, failed)
	}
}

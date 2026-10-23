package bridge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentRegistryContracts(t *testing.T) {
	_, scope := installTestScope(t)
	keys, aliases := map[string]bool{}, map[string]bool{}
	for index := range installAgentRegistry {
		agent := &installAgentRegistry[index]
		if agent.key == "" || agent.label == "" || keys[agent.key] {
			t.Fatalf("empty or duplicate registry identity: %+v", agent)
		}
		keys[agent.key] = true
		if installAgentByKey(agent.key) != agent || installAgentNames[index] != agent.key || installAgentLabels[agent.key] != agent.label {
			t.Fatal("derived identity/order differs from registry", agent.key)
		}
		for _, alias := range agent.aliases {
			if aliases[alias] || installAgentByKey(alias) != nil {
				t.Fatal("ambiguous alias", alias)
			}
			aliases[alias] = true
			got, err := installParseTargets(alias, true)
			if err != nil || strings.Join(got, ",") != agent.key {
				t.Fatalf("registry alias %s: %v %v", alias, got, err)
			}
		}
		if agent.mcp.paths == nil || agent.skill.base == nil {
			t.Fatal("incomplete setup definition", agent.key)
		}
		if agent.mcp.format > installConfigYAML || (agent.mcp.format == installConfigJSON && len(agent.mcp.entry) == 0) {
			t.Fatal("missing config format/entry", agent.key)
		}
		presence := agent.presence
		if agent.key != "agents" && len(presence.commands) == 0 && presence.detect == nil && presence.nativePaths == nil && presence.extension.name == "" {
			t.Fatal("missing presence definition", agent.key)
		}
		for _, global := range []bool{true, false} {
			scope.global = global
			paths := installMCPPaths(agent.key, scope)
			if len(paths) == 0 && (global || !agent.mcp.userOnly) {
				t.Fatal("missing supported-scope config path", agent.key)
			}
			if !global && agent.mcp.userOnly && len(paths) != 0 {
				t.Fatal("advertised unsupported project MCP", agent.key)
			}
			for _, path := range paths {
				if !filepath.IsAbs(path) || installMCPKey(agent.key, path, scope) == "" {
					t.Fatal("invalid config path/key", agent.key, path)
				}
			}
			if !filepath.IsAbs(installSkillBase(agent.key, scope)) {
				t.Fatal("invalid skill path", agent.key)
			}
		}
	}
	if len(installAgentNames) != len(keys) || installAgentNames[len(installAgentNames)-1] != "agents" {
		t.Fatal("derived target list drifted or generic agents is not last")
	}
	if installAgentByKey("unknown") != nil || installAgentDetected("unknown", scope) || installMCPKey("unknown", "", scope) != "" {
		t.Fatal("unknown agent resolved to a real target")
	}
}

func TestAgentRegistryDrivesSharedInstallers(t *testing.T) {
	_, scope := installTestScope(t)
	// One new descriptor is sufficient. No shared installer/detector switch or
	// UI list needs a corresponding target branch.
	agent := installAgentDefinition{
		key: "registry-fixture", label: "Registry fixture",
		mcp:      installAgentMCPDefinition{key: "fixture_servers", entry: installLocalArrayEntry(), transport: installTransportLocalArray, paths: installScopedConfigPaths(".fixture/mcp.json", ".fixture/mcp.json")},
		skill:    installAgentSkillDefinition{base: installScopedDirectory(".fixture/skills", ".fixture/skills")},
		presence: installAgentPresence{commands: []string{"registry-fixture"}, packages: []string{"@fixture/agent"}},
	}
	original := installAgentRegistry
	installAgentRegistry = append(append([]installAgentDefinition{}, original...), agent)
	t.Cleanup(func() { installAgentRegistry = original })
	bin := filepath.Join(scope.home, "package", "bin")
	installTestExecutable(t, filepath.Join(bin, agent.key))
	installTestWrite(t, filepath.Join(scope.home, "package", "package.json"), `{"name":"@fixture/agent"}`)
	t.Setenv("PATH", bin)
	if !installAgentDetected(agent.key, scope) {
		t.Fatal("presence detector ignored registry definition")
	}
	paths, err := installAgentMCP(agent.key, scope, false)
	if err != nil || len(paths) != 1 {
		t.Fatalf("installer ignored registry definition: %v %v", paths, err)
	}
	raw, err := os.ReadFile(paths[0])
	if err != nil || !installMCPConfigured(string(raw), agent.key, paths[0], scope) || !strings.Contains(string(raw), "fixture_servers") {
		t.Fatal("config editor ignored registry key", err, string(raw))
	}
	if got := installSkillBase(agent.key, scope); got != filepath.Join(scope.home, ".fixture", "skills") {
		t.Fatal("skill resolver ignored registry", got)
	}
	if _, err := installAgentMCP(agent.key, scope, true); err != nil {
		t.Fatal(err)
	}
}

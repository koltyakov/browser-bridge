package bridge

import (
	"strings"
	"testing"
)

func TestCLIRegistryContracts(t *testing.T) {
	seen := map[string]bool{}
	shortcuts := 0
	for _, command := range cliCommands {
		if command.name == "" || seen[command.name] {
			t.Fatal("empty or duplicate CLI command", command.name)
		}
		seen[command.name] = true
		if isFileCommand(command.name) != command.file || localOnlyCommand(command.name) != command.localOnly {
			t.Fatal("command policy drift", command.name)
		}
		if command.category != "" && !strings.HasPrefix(command.usage, command.name) {
			t.Fatal("help drift", command.name)
		}
		if command.method != "" {
			shortcuts++
			if _, exists := catalog.Methods[command.method]; !exists || shortcutMethods[command.name] != command.method {
				t.Fatal("unknown shortcut method", command.name)
			}
			want := ""
			if command.summarize {
				want = command.method
			}
			if cliShortcutPrintMethod(command.name) != want {
				t.Fatal("output policy drift", command.name)
			}
		}
	}
	if shortcuts != len(shortcutMethods) || isFileCommand("unknown") || localOnlyCommand("unknown") {
		t.Fatal("derived registry drift")
	}
}

func TestShortcutRegistryParserIsExtensible(t *testing.T) {
	original := cliCommands
	cliCommands = append(append([]cliCommandDefinition{}, original...), cliCommandDefinition{
		name: "fixture-command", method: "dom.get_text", target: true, summarize: true,
		parse: func(a *cliShortcutArgs) { a.params["textBudget"] = value(42) },
	})
	t.Cleanup(func() { cliCommands = original })
	method, params, err := buildShortcut("fixture-command", []string{"main"})
	if err != nil || method != "dom.get_text" || params.number("textBudget") != 42 || params.object("target").text("selector") != "main" || cliShortcutPrintMethod("fixture-command") != method {
		t.Fatalf("registry entry was ignored: %s %s %v", method, value(params), err)
	}
}

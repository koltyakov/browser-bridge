package bridge

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strings"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

var callerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$`)
var callerVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
var callerSignalPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// Attribution is diagnostic and self-reported, never an authorization signal.
func normalizeCaller(raw json.RawMessage) *protocol.BridgeCaller {
	candidate, err := decodeObject(raw)
	if err != nil {
		return nil
	}
	name, source := strings.TrimSpace(candidate.text("name")), candidate.text("source")
	if !callerNamePattern.MatchString(name) || !stringIn(source, []string{"mcp", "environment", "explicit"}) {
		return nil
	}
	caller := &protocol.BridgeCaller{Name: name, Source: protocol.BridgeCallerSource(source)}
	if version := strings.TrimSpace(candidate.text("version")); callerVersionPattern.MatchString(version) {
		caller.Version = protocol.Optional[string]{Value: version, Set: true}
	}
	if signal := candidate.text("signal"); source == "environment" && callerSignalPattern.MatchString(signal) {
		caller.Signal = protocol.Optional[string]{Value: signal, Set: true}
	}
	return caller
}

func callerDisplayName(name string) string {
	compact := func(s string) string {
		return strings.Map(func(r rune) rune {
			if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, strings.ToLower(s))
	}
	key := compact(name)
	// Known wire names do not always match the installation target key.
	switch key {
	case "codexmcpclient", "codexcli":
		key = "codex"
	case "claudecodecli":
		key = "claude"
	}
	for _, agent := range installAgentRegistry {
		if key == compact(agent.key) || key == compact(agent.label) {
			return agent.label
		}
	}
	return name
}

func reportedCaller(info object) *protocol.BridgeCaller {
	caller := normalizeCaller(value(object{"name": info["name"], "version": info["version"], "source": value("mcp")}))
	if caller != nil {
		caller.Name = callerDisplayName(caller.Name)
	}
	return caller
}

func environmentCaller(getenv func(string) string) *protocol.BridgeCaller {
	if name := strings.TrimSpace(getenv("BBX_AGENT")); name != "" {
		caller := normalizeCaller(value(object{"name": value(name), "source": value("explicit")}))
		if caller != nil {
			caller.Name = callerDisplayName(caller.Name)
		}
		return caller
	}
	var caller *protocol.BridgeCaller
	for _, marker := range []struct {
		key, agent string
		identifier bool
	}{
		{"OPENCODE", "opencode", false},
		{"CLAUDECODE", "claude", false},
		{"CODEX_THREAD_ID", "codex", true},
		{"CODEX_CI", "codex", false},
		{"CURSOR_AGENT", "cursor", false},
		{"GEMINI_CLI", "gemini", false},
	} {
		v := strings.TrimSpace(getenv(marker.key))
		if v == "" || (!marker.identifier && v != "1" && !strings.EqualFold(v, "true")) {
			continue
		}
		name := callerDisplayName(marker.agent)
		if caller != nil {
			if caller.Name != name {
				return nil // Nested harnesses can inherit conflicting markers.
			}
			continue
		}
		caller = &protocol.BridgeCaller{Name: name, Source: "environment", Signal: protocol.Optional[string]{Value: marker.key, Set: true}}
	}
	return caller
}

type mcpCallerContextKey struct{}

// Modern MCP identity belongs to each request, not the shared stdio connection.
func (s *mcpSession) callerContext(ctx context.Context, era string, envelope object) context.Context {
	caller := environmentCaller(os.Getenv)
	if caller == nil || caller.Source != "explicit" {
		reported := s.caller
		if era == "modern" {
			reported = reportedCaller(envelope.object("io.modelcontextprotocol/clientInfo"))
		}
		if reported != nil {
			caller = reported
		}
	}
	if caller == nil {
		return ctx
	}
	return context.WithValue(ctx, mcpCallerContextKey{}, caller)
}

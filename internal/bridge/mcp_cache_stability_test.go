package bridge

import (
	"bytes"
	"testing"
)

// Prompt caches key on the exact tool and instruction bytes. Anything that
// varies with connection state (connected browsers, a chosen destination, a
// remote) would invalidate every client's cache on reconnect.
func TestMCPToolsAndInstructionsAreByteStableAcrossConnectionState(t *testing.T) {
	disconnected := &mcpSession{config: config{home: t.TempDir()}, agentSession: "a"}
	remote := &mcpSession{config: config{home: t.TempDir(), remote: true, network: "tcp", address: "10.0.0.2:9223"}, agentSession: "b"}
	for _, era := range []string{"modern", ""} {
		first := value(disconnected.tools(era))
		second := value(remote.tools(era))
		again := value(disconnected.tools(era))
		if !bytes.Equal(first, second) || !bytes.Equal(first, again) {
			t.Fatalf("tools/list bytes differ by connection state for era %q", era)
		}
	}
	if !bytes.Equal(value(mcpInitializeResult("2025-06-18")), value(mcpInitializeResult("2025-06-18"))) {
		t.Fatal("initialize result is not deterministic")
	}
	if !bytes.Equal(value(mcpDiscoverResult()), value(mcpDiscoverResult())) {
		t.Fatal("server/discover result is not deterministic")
	}
}

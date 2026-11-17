package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/json/jsontext"
	"errors"
	"os"
	"strings"
	"unicode"
)

const openCodeSessionKey = "ai.opencode/sessionID"
const maxHostSessionBytes = 1024

type mcpConversationContextKey struct{}

// Host session metadata partitions a shared MCP connection. It is self-reported
// correlation data, not authentication, browser access, or a reusable grant.
func (s *mcpSession) conversationContext(ctx context.Context, envelope object) (context.Context, error) {
	raw, present := envelope[openCodeSessionKey]
	if !present {
		return ctx, nil
	}
	var session string
	if err := json.Unmarshal(raw, &session); err != nil || !jsontext.Value(raw).IsValid() || len(session) > maxHostSessionBytes || strings.TrimSpace(session) == "" || strings.ContainsFunc(session, unicode.IsControl) {
		return nil, errors.New("Tool request _meta ai.opencode/sessionID must be a nonblank string of at most 1024 bytes without control characters.")
	}
	s.mu.Lock()
	if s.agentSession == "" {
		s.agentSession = os.Getenv("BBX_SESSION")
		if s.agentSession == "" {
			s.agentSession = "mcp_" + uniqueID()
		}
	}
	if s.conversationNamespace == "" {
		// A new server instance must not regain another instance's conversation
		// resources, even when the host ID and BBX_SESSION are identical.
		s.conversationNamespace = uniqueID()
	}
	// JSON encoding keeps the namespace components unambiguous. Hashing keeps
	// raw host conversation IDs out of downstream requests and logs.
	digest := sha256.Sum256(value([]string{openCodeSessionKey, s.conversationNamespace, s.agentSession, session}))
	s.mu.Unlock()
	identity := "mcp_" + hex.EncodeToString(digest[:])
	return context.WithValue(ctx, mcpConversationContextKey{}, identity), nil
}

package bridge

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"
)

type mcpConnecting struct {
	done   chan struct{}
	client *client
	err    error
}

func mcpConnect(c config, clientID string) (*client, error) {
	conn, reader, reply, err := registerConnectionAs(c, "agent", clientID)
	if err != nil {
		return nil, err
	}
	cl := &client{conn: conn, writer: wireWriter{out: conn}, pending: make(map[string]chan callResult), supportsCancellation: reply.boolean("requestCancellation")}
	go cl.read(reader)
	return cl, nil
}

func (s *mcpSession) destinationConnectionContext(ctx context.Context, destination string) (*client, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if destination == "" {
		destination = "local"
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("MCP connection is closed")
	}
	if s.clientID == "" {
		s.clientID = "mcp_" + uniqueID()
	}
	if s.agentSession == "" {
		s.agentSession = strings.TrimSpace(os.Getenv("BBX_SESSION"))
		if s.agentSession == "" {
			s.agentSession = s.clientID
		}
	}
	if s.clients == nil {
		s.clients = make(map[string]*client)
	}
	if cl := s.clients[destination]; cl != nil {
		cl.mu.Lock()
		closed := cl.closed != nil
		cl.mu.Unlock()
		if !closed {
			s.mu.Unlock()
			return cl, nil
		}
		delete(s.clients, destination)
	}
	if s.connecting == nil {
		s.connecting = make(map[string]*mcpConnecting)
	}
	pending := s.connecting[destination]
	if pending == nil {
		pending = &mcpConnecting{done: make(chan struct{})}
		s.connecting[destination] = pending
		clientID := s.clientID
		go func() {
			cfg := s.config
			var err error
			if destination != "local" {
				cfg, err = destinationConfig(cfg, destination)
			}
			var cl *client
			if err == nil {
				cl, err = mcpConnect(cfg, clientID)
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.closed && cl != nil {
				cl.close()
				cl = nil
				err = errors.New("MCP connection is closed")
			}
			if cl != nil {
				s.clients[destination] = cl
				if destination == "local" {
					s.client = cl
				}
			}
			pending.client, pending.err = cl, err
			delete(s.connecting, destination)
			close(pending.done)
		}()
	}
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-pending.done:
		return pending.client, pending.err
	}
}

func mcpRetrySafe(method string, params object) bool {
	if method == "access.wait_for_change" {
		return true
	}
	if method == "page.get_console" || method == "page.get_network" {
		return batchSafe(method, params)
	}
	switch method {
	case "webmcp.list_tools", "webmcp.get_tool", "skill.get_runtime_context", "setup.get_status", "log.tail", "health.ping", "daemon.metrics", "tabs.list", "page.get_state", "page.get_storage", "page.get_text", "page.extract_content", "dom.query", "dom.baseline.compare", "dom.baseline.describe", "dom.describe", "dom.get_text", "dom.get_attributes", "dom.wait_for", "dom.find_by_text", "dom.find_by_role", "dom.get_html", "dom.get_accessibility_tree", "layout.get_box_model", "layout.hit_test", "styles.get_computed", "styles.get_matched_rules", "screenshot.capture_region", "screenshot.capture_element", "screenshot.capture_full_page", "artifact.read", "network.intercept.list", "performance.get_metrics", "cdp.get_document", "cdp.get_dom_snapshot", "cdp.get_box_model", "cdp.get_computed_styles_for_node":
		return true
	}
	return false
}

func mcpConnectionLost(err error) bool {
	return isDaemonUnavailable(err) || connectionLost(err)
}
func mcpPause(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *mcpSession) requestWithRetry(ctx context.Context, method string, params, meta, args object) (object, error) {
	cl, err := s.destinationConnectionContext(ctx, args.text("destinationId"))
	if err != nil {
		return nil, err
	}
	response, err := cl.request(ctx, newRequest(method, params, meta, args.number("tabId")))
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if !mcpRetrySafe(method, params) {
		return response, err
	}
	if err != nil {
		if !mcpConnectionLost(err) {
			return nil, err
		}
		deadline := time.Now().Add(5 * time.Second)
		original := err
		for time.Now().Before(deadline) {
			if err = mcpPause(ctx, 250*time.Millisecond); err != nil {
				return nil, err
			}
			attemptCtx, cancel := context.WithDeadline(ctx, deadline)
			cl, err = s.destinationConnectionContext(attemptCtx, args.text("destinationId"))
			cancel()
			if err == nil {
				meta = mcpClone(meta)
				meta["automatic_retry"] = value(object{"attempt": value(2), "reason": value("retryable_error")})
				return cl.request(ctx, newRequest(method, params, meta, args.number("tabId")))
			}
		}
		return nil, original
	}
	recovery := response.object("error").object("recovery")
	if recovery == nil {
		recovery = cliErrorRecovery(response.object("error").text("code"))
	}
	if !response.boolean("ok") && recovery.boolean("retry") {
		delay := recovery.number("retryAfterMs")
		if recovery["retryAfterMs"] == nil {
			delay = 1000
		}
		if err = mcpPause(ctx, time.Duration(max(0, delay))*time.Millisecond); err != nil {
			return nil, err
		}
		meta = mcpClone(meta)
		meta["automatic_retry"] = value(object{"attempt": value(2), "reason": value("retryable_error")})
		return cl.request(ctx, newRequest(method, params, meta, args.number("tabId")))
	}
	return response, nil
}

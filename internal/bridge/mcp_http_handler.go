package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

func (h *mcpHTTPServer) authenticate(r *http.Request) (string, [32]byte, bool) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return "", [32]byte{}, false
	}
	scheme, token, _ := strings.Cut(values[0], " ")
	if !strings.EqualFold(scheme, "Bearer") || !tokenPattern.MatchString(token) {
		return "", [32]byte{}, false
	}
	name := ""
	for client, path := range h.settings.Clients {
		current, err := mcpHTTPCredential(path)
		if err == nil && h.dedicatedToken(current) && tokensEqual(token, current) {
			if name != "" {
				return "", [32]byte{}, false // Ambiguous shared credentials fail closed.
			}
			name = client
		}
	}
	return name, sha256.Sum256([]byte(token)), name != ""
}

func (h *mcpHTTPServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if h.closed || h.ctx.Err() != nil || h.active >= 128 {
		h.mu.Unlock()
		mcpHTTPError(w, http.StatusServiceUnavailable, nil, -32603, "MCP HTTP is unavailable or at capacity.")
		return
	}
	h.active++
	h.workers.Add(1)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.active--
		h.mu.Unlock()
		h.workers.Done()
	}()
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path != "/mcp" {
		http.NotFound(w, r)
		return
	}
	if r.URL.RawQuery != "" {
		mcpHTTPError(w, http.StatusBadRequest, nil, -32600, "MCP endpoint query parameters are not accepted.")
		return
	}
	if !h.validOrigin(r) {
		mcpHTTPError(w, http.StatusForbidden, nil, -32600, "Host or Origin is not permitted.")
		return
	}
	credential, digest, ok := h.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Bearer realm="Browser Bridge MCP"`)
		mcpHTTPError(w, http.StatusUnauthorized, nil, -32600, "A valid MCP HTTP client credential is required.")
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodDelete {
		h.legacyStreamOrDelete(w, r, credential, digest)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, GET, DELETE")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	message, ok := mcpHTTPMessage(w, r)
	if !ok {
		return
	}
	params, method, id := message.object("params"), message.text("method"), message["id"]
	modern := params.object("_meta")[versionKey] != nil || r.Header.Get("MCP-Protocol-Version") == modernVersion
	if modern && !mcpHTTPModern(w, r, message) {
		return
	}
	sessionID := r.Header.Get("Mcp-Session-Id")
	revision, key, create := "", "legacy/"+sessionID, false
	if modern {
		revision, key, create = modernVersion, "modern/"+credential+"/"+hex.EncodeToString(digest[:]), true
	} else if method == "initialize" && id != nil {
		if sessionID != "" {
			mcpHTTPError(w, http.StatusBadRequest, id, -32600, "Initialize without an existing session ID.")
			return
		}
		revision = params.text("protocolVersion")
		if !mcpHTTPLegacyVersion(revision) {
			revision = "2025-11-25"
		}
		sessionID, create = uniqueID(), true
		key = "legacy/" + sessionID
	} else if sessionID == "" {
		mcpHTTPError(w, http.StatusBadRequest, id, -32600, "Initialize a legacy session or send modern request metadata.")
		return
	}
	owner := h.owner(credential, digest, key, revision, create)
	if owner == nil {
		status := http.StatusNotFound
		if create {
			status = http.StatusServiceUnavailable
		}
		mcpHTTPError(w, status, id, -32600, "MCP owner is unavailable, expired, or at capacity.")
		return
	}
	defer h.release(owner)
	if !modern && method != "initialize" && !h.legacyVersion(w, r, owner, id) {
		return
	}
	era := "legacy"
	if modern {
		era = "modern"
	}
	if id == nil {
		if modern {
			mcpHTTPError(w, http.StatusBadRequest, nil, -32600, "No modern client notifications are supported on HTTP; close the response stream to cancel.")
			return
		}
		if method == "notifications/cancelled" {
			h.mu.Lock()
			cancel := owner.pending[string(params["requestId"])]
			h.mu.Unlock()
			if cancel != nil {
				cancel()
			}
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	switch method {
	case "initialize":
		if modern {
			mcpHTTPError(w, http.StatusNotFound, id, -32601, "Modern MCP does not use initialize.")
			return
		}
		owner.session.mu.Lock()
		owner.session.caller = reportedCaller(params.object("clientInfo"))
		owner.session.mu.Unlock()
		w.Header().Set("Mcp-Session-Id", sessionID)
		mcpHTTPJSON(w, http.StatusOK, rpcResult(id, mcpInitializeResult(revision)))
	case "server/discover":
		if !modern {
			mcpHTTPError(w, http.StatusOK, id, -32601, "Method not found: "+method)
			return
		}
		mcpHTTPJSON(w, http.StatusOK, mcpRPCResult(id, method, era, mcpDiscoverResult()))
	case "tools/list":
		mcpHTTPJSON(w, http.StatusOK, mcpRPCResult(id, method, era, object{"tools": value(owner.session.tools(era))}))
	case "ping":
		mcpHTTPJSON(w, http.StatusOK, mcpRPCResult(id, method, era, object{}))
	case "tools/call":
		h.call(w, r, owner, message, era)
	case "subscriptions/listen":
		if !modern {
			mcpHTTPError(w, http.StatusOK, id, -32601, "Method not found: "+method)
			return
		}
		ack := make(mcpSubscriptions).listen(id, params)
		if ack["error"] != nil {
			mcpHTTPJSON(w, http.StatusOK, ack)
			return
		}
		h.stream(w, r, owner, ack, false)
	default:
		status := http.StatusOK
		if modern {
			status = http.StatusNotFound
		}
		mcpHTTPError(w, status, id, -32601, "Method not found: "+method)
	}
}

func (h *mcpHTTPServer) legacyVersion(w http.ResponseWriter, r *http.Request, owner *mcpHTTPOwner, id json.RawMessage) bool {
	revision := r.Header.Get("MCP-Protocol-Version")
	if revision == "" && owner.revision == "2025-03-26" {
		return true
	}
	if revision != owner.revision {
		mcpHTTPError(w, http.StatusBadRequest, id, -32600, "HTTP protocol version does not match the legacy session.")
		return false
	}
	return true
}

func (h *mcpHTTPServer) legacyStreamOrDelete(w http.ResponseWriter, r *http.Request, credential string, digest [32]byte) {
	if r.Header.Get("MCP-Protocol-Version") == modernVersion || r.Header.Get("Mcp-Session-Id") == "" {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	key := "legacy/" + r.Header.Get("Mcp-Session-Id")
	owner := h.owner(credential, digest, key, "", false)
	if owner == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	defer h.release(owner)
	if !h.legacyVersion(w, r, owner, nil) {
		return
	}
	if r.Method == http.MethodDelete {
		h.remove(key, owner)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !mcpHTTPAccept(r, "text/event-stream") {
		w.WriteHeader(http.StatusNotAcceptable)
		return
	}
	h.stream(w, r, owner, nil, true)
}

func mcpHTTPStartSSE(w http.ResponseWriter) bool {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	return mcpHTTPEvent(w, nil)
}

// mcpHTTPHeartbeatInterval spaces SSE comments on a stream awaiting a result.
const mcpHTTPHeartbeatInterval = 15 * time.Second

// mcpHTTPHeartbeat writes SSE keep-alive comments until the returned stop
// function runs. stop waits for the writer, so the caller's next write never
// overlaps a heartbeat.
func mcpHTTPHeartbeat(w http.ResponseWriter, interval time.Duration) func() {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if !mcpHTTPEvent(w, nil) {
					return
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			<-finished
		})
	}
}

func mcpHTTPEvent(w http.ResponseWriter, payload []byte) bool {
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
	var err error
	if payload == nil {
		_, err = fmt.Fprint(w, ": keep-alive\n\n")
	} else {
		_, err = fmt.Fprintf(w, "data: %s\n\n", payload)
	}
	if err != nil {
		return false
	}
	// Expiring the last write deadline while a subscription is quiet would
	// kill an otherwise healthy stream before the next heartbeat.
	if err := controller.Flush(); err != nil {
		return false
	}
	_ = controller.SetWriteDeadline(time.Time{})
	return true
}

func (h *mcpHTTPServer) stream(w http.ResponseWriter, r *http.Request, owner *mcpHTTPOwner, ack object, legacy bool) {
	h.mu.Lock()
	if owner.streams >= 16 || h.streams >= mcpHTTPMaxStreams || (legacy && owner.eventsOpen) {
		h.mu.Unlock()
		mcpHTTPError(w, http.StatusServiceUnavailable, nil, -32603, "MCP stream limit reached.")
		return
	}
	owner.streams++
	h.streams++
	owner.active-- // A quiet notification stream must not defeat owner expiry.
	if legacy {
		owner.eventsOpen = true
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		owner.streams--
		h.streams--
		owner.active++
		if legacy {
			owner.eventsOpen = false
		}
		h.mu.Unlock()
	}()
	if !mcpHTTPStartSSE(w) || (ack != nil && !mcpHTTPEvent(w, value(ack))) {
		return
	}
	var events <-chan object
	if legacy {
		events = owner.events
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-owner.ctx.Done():
			return
		case message := <-events:
			if !mcpHTTPEvent(w, value(message)) {
				return
			}
		case <-ticker.C:
			if !mcpHTTPEvent(w, nil) {
				return
			}
		}
	}
}

func (h *mcpHTTPServer) call(w http.ResponseWriter, r *http.Request, owner *mcpHTTPOwner, message object, era string) {
	id := message["id"]
	ctx, cancel := context.WithTimeout(owner.ctx, 124*time.Second)
	defer cancel()
	if era == "modern" {
		stop := context.AfterFunc(r.Context(), cancel)
		defer stop()
	}
	key := string(id)
	if era == "modern" {
		key = uniqueID() // JSON-RPC IDs are scoped to each HTTP request.
	}
	h.mu.Lock()
	_, duplicate := owner.pending[key]
	if duplicate || owner.calls >= 16 {
		h.mu.Unlock()
		mcpHTTPError(w, http.StatusOK, id, -32603, "Duplicate active request ID or too many concurrent MCP calls.")
		return
	}
	owner.pending[key] = cancel
	owner.calls++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(owner.pending, key)
		owner.calls--
		h.mu.Unlock()
	}()
	ctx, name, arguments, invalid := owner.session.prepareCall(ctx, message.object("params"), era)
	if invalid != nil {
		invalid["id"] = id
		mcpHTTPJSON(w, http.StatusOK, invalid)
		return
	}
	if name == "browser_toolset" {
		result, newly := owner.session.enableTool(arguments.text("tool"))
		if newly {
			h.mu.Lock()
			select {
			case owner.events <- object{"jsonrpc": value("2.0"), "method": value("notifications/tools/list_changed")}:
			default:
				owner.cancel()
			}
			h.mu.Unlock()
		}
		mcpHTTPJSON(w, http.StatusOK, rpcResult(id, result))
		return
	}
	modern := era == "modern"
	if modern && !mcpHTTPStartSSE(w) {
		return
	}
	// Legacy work deliberately outlives an HTTP disconnect. Its session,
	// explicit cancellation notification and deadline control its lifetime.
	stopHeartbeat := func() {}
	if modern {
		// A tool call can run for up to two minutes. Keep the stream visibly
		// alive so proxies and clients do not close an idle connection.
		stopHeartbeat = mcpHTTPHeartbeat(w, mcpHTTPHeartbeatInterval)
	}
	result, err := owner.session.tool(ctx, name, arguments, era)
	stopHeartbeat()
	if modern && r.Context().Err() != nil {
		return
	}
	payload, err := mcpToolPayload(id, era, toolResult(result, err))
	if err != nil {
		return
	}
	if modern {
		mcpHTTPEvent(w, payload)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = w.Write(payload)
}

package bridge

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type peer struct {
	conn          net.Conn
	out           chan queuedMessage
	queuedBytes   atomic.Int64
	queueMu       sync.Mutex
	done          chan struct{}
	role          string
	id            string
	owner         string
	identity      object
	access        bool
	active        int64
	window        object
	windowPush    bool
	windowControl bool
	pending       int
	dataTargets   map[*peer]bool
}

type queuedMessage struct {
	message object
	bytes   int64
	onWrite func(bool)
}

type pendingRequest struct {
	owner      *peer
	target     *peer
	original   string
	method     string
	timer      *time.Timer
	baselineID string
	localError object
	started    time.Time
	meta       object
}

type daemon struct {
	mu                                sync.Mutex
	config                            config
	agentToken                        string
	extensionToken                    string
	peers                             map[*peer]bool
	pending                           map[string]*pendingRequest
	logs                              []object
	artifacts                         *artifactStore
	recordings                        *recordingStore
	baselines                         *baselineRegistry
	windowActions                     map[string]*pendingWindowAction
	telemetry                         recoveryTelemetry
	started                           time.Time
	processed, failed, responseMillis int64
}

func success(id string, result object) object {
	return object{"id": value(id), "ok": value(true), "result": value(result), "error": value[*string](nil), "meta": value(object{"protocol_version": value(protocolVersion())})}
}

func failure(id, code, message string) object {
	err := object{"code": value(code), "message": value(message), "details": value[*string](nil)}
	if recovery := daemonErrorRecovery(code); recovery != nil {
		err["recovery"] = value(recovery)
	}
	return object{"id": value(id), "ok": value(false), "result": value[*string](nil), "error": value(err), "meta": value(object{"protocol_version": value(protocolVersion())})}
}

// All state belongs to daemon.mu. Sending is bounded and never waits while
// holding it; each connection has one writer with a deadline.
func (p *peer) send(message object) {
	p.enqueue(message, nil)
}

func (p *peer) enqueue(message object, onWrite func(bool)) bool {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()
	select {
	case <-p.done:
		return false
	default:
	}
	size := int64(len(value(message)) + 1)
	if size-1 > maxMessageBytes {
		_ = p.conn.Close()
		return false
	}
	if p.queuedBytes.Add(size) > 4*maxMessageBytes {
		p.queuedBytes.Add(-size)
		_ = p.conn.Close()
		return false
	}
	select {
	case p.out <- queuedMessage{message: message, bytes: size, onWrite: onWrite}:
		return true
	case <-p.done:
		p.queuedBytes.Add(-size)
	default:
		p.queuedBytes.Add(-size)
		_ = p.conn.Close()
	}
	return false
}

func (p *peer) respond(response object) {
	p.send(object{"type": value("agent.response"), "response": value(response)})
}

func listen(c config) (net.Listener, error) {
	if c.network == "unix" {
		if err := os.MkdirAll(c.home, 0700); err != nil {
			return nil, err
		}
		// Never unlink a live listener or a non-socket file. An already-running
		// daemon is authoritative, whether it is the Node or native implementation.
		if info, err := os.Lstat(c.address); err == nil {
			if info.Mode()&os.ModeSocket == 0 {
				return nil, errors.New("bridge endpoint exists and is not a socket")
			}
			conn, err := c.dial()
			if err == nil {
				_ = conn.Close()
				return nil, errors.New("another daemon is already running")
			}
			// Refuse ambiguous failures such as permission errors and timeouts.
			if !isRefused(err) {
				return nil, err
			}
			if err := os.Remove(c.address); err != nil {
				return nil, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	listener, err := c.listen()
	if err == nil && c.network == "unix" {
		if chmodErr := os.Chmod(c.address, 0600); chmodErr != nil {
			_ = listener.Close()
			return nil, chmodErr
		}
	}
	return listener, err
}

func runDaemon(ctx context.Context, c config) error {
	agent, err := ensureToken(c.agentToken)
	if err != nil {
		return err
	}
	if override := os.Getenv("BBX_AUTH_TOKEN"); override != "" {
		if !tokenPattern.MatchString(override) {
			return errors.New("invalid BBX_AUTH_TOKEN")
		}
		agent = override
	}
	extension, err := ensureToken(filepath.Join(c.home, "daemon.extension.auth"))
	if err != nil {
		return err
	}
	listener, err := listen(c)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	d := &daemon{config: c, agentToken: agent, extensionToken: extension, peers: make(map[*peer]bool), pending: make(map[string]*pendingRequest), started: time.Now()}
	d.initServices()
	if err := d.artifacts.reset(); err != nil {
		return err
	}
	pidPath := filepath.Join(c.home, "daemon.pid")
	pid := []byte(fmt.Sprintf("%d\n", os.Getpid()))
	if err := os.WriteFile(pidPath, pid, 0600); err != nil {
		return err
	}
	defer func() {
		if current, err := os.ReadFile(pidPath); err == nil && bytes.Equal(current, pid) {
			_ = os.Remove(pidPath)
		}
	}()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = listener.Close()
				return
			case <-finished:
				return
			case <-ticker.C:
				d.mu.Lock()
				d.artifacts.prune()
				d.baselines.prune()
				d.mu.Unlock()
			}
		}
	}()
	var workers sync.WaitGroup
	defer func() {
		d.mu.Lock()
		for p := range d.peers {
			_ = p.conn.Close()
		}
		for _, pending := range d.pending {
			pending.timer.Stop()
		}
		for id := range d.windowActions {
			d.finishWindowAction(id, "The daemon stopped. Try again.")
		}
		d.mu.Unlock()
		workers.Wait()
		d.mu.Lock()
		_ = d.artifacts.reset()
		d.mu.Unlock()
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		d.mu.Lock()
		if len(d.peers) >= 64 {
			d.mu.Unlock()
			_ = conn.Close()
			continue
		}
		p := &peer{conn: conn, out: make(chan queuedMessage, 32), done: make(chan struct{}), identity: object{}, owner: uniqueID(), dataTargets: make(map[*peer]bool)}
		d.peers[p] = true
		d.mu.Unlock()
		workers.Add(1)
		go func() {
			defer workers.Done()
			d.serve(p)
		}()
	}
}

func (d *daemon) serve(p *peer) {
	defer func() { _ = p.conn.Close() }()
	defer d.disconnect(p)
	writerDone := make(chan struct{})
	defer func() {
		p.queueMu.Lock()
		close(p.done)
		p.queueMu.Unlock()
		<-writerDone
	}()
	go func() {
		defer close(writerDone)
		defer func() {
			// No more enqueue operations can succeed once done is closed. Fail
			// undelivered callbacks before disconnect removes the peer's state.
			<-p.done
			for {
				select {
				case queued := <-p.out:
					p.queuedBytes.Add(-queued.bytes)
					if queued.onWrite != nil {
						queued.onWrite(false)
					}
				default:
					return
				}
			}
		}()
		writer := wireWriter{out: p.conn}
		for {
			select {
			case queued := <-p.out:
				_ = p.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				err := writer.send(queued.message)
				p.queuedBytes.Add(-queued.bytes)
				if err != nil {
					_ = p.conn.Close()
					if queued.onWrite != nil {
						queued.onWrite(false)
					}
					return
				}
				if queued.onWrite != nil {
					queued.onWrite(true)
				}
			case <-p.done:
				return
			}
		}
	}()
	reader := bufio.NewReader(p.conn)
	_ = p.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	message, err := readLine(reader)
	if err != nil {
		return
	}
	d.mu.Lock()
	role := message.text("role")
	token := d.agentToken
	if role == "extension" {
		token = d.extensionToken
	}
	valid := message.text("type") == "register" && (role == "agent" || role == "extension") && tokensEqual(message.text("authToken"), token)
	if role == "agent" && !validID(message.text("clientId")) {
		valid = false
	}
	if valid {
		p.role, p.id, p.active = role, uniqueID(), time.Now().UnixMilli()
		d.identity(p, message)
	}
	d.mu.Unlock()
	if !valid {
		// Registration has no concurrent responses yet; write the rejection
		// synchronously so the peer receives it before close.
		writer := wireWriter{out: p.conn}
		_ = p.conn.SetWriteDeadline(time.Now().Add(time.Second))
		_ = writer.send(object{"type": value("registration_failed"), "error": value(object{"code": value("ACCESS_DENIED"), "message": value("Bridge daemon authentication or registration failed.")})})
		return
	}
	ack := object{"type": value("registered"), "role": value(role)}
	if role == "agent" {
		ack["clientId"] = message["clientId"]
	}
	p.send(ack)
	if p.role == "extension" {
		d.mu.Lock()
		d.windows()
		d.mu.Unlock()
	}
	_ = p.conn.SetReadDeadline(time.Time{})
	for {
		message, err := readLine(reader)
		if err != nil {
			return
		}
		d.mu.Lock()
		d.handle(p, message)
		d.mu.Unlock()
	}
}

func validID(id string) bool {
	return validText(id, 128)
}

func validText(id string, limit int) bool {
	if strings.TrimSpace(id) == "" || len(id) > limit {
		return false
	}
	for _, c := range id {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

func (d *daemon) identity(p *peer, message object) {
	for _, key := range []string{"browserName", "profileLabel"} {
		if s := message.text(key); validText(s, 128) {
			p.identity[key] = value(s)
		}
	}
	if raw := message["browserExtensionId"]; len(raw) > 0 && raw[0] == '"' {
		delete(p.identity, "browserExtensionId")
		if id := message.text("browserExtensionId"); browserExtensionIDPattern.MatchString(id) {
			p.identity["browserExtensionId"] = value(id)
		}
	}
	if message.boolean("windowAccessUpdates") {
		p.windowPush = true
	}
	if message.boolean("windowActions") {
		p.windowControl = true
	}
}

func (d *daemon) snapshot() []object {
	result := []object{}
	for p := range d.peers {
		if p.role != "extension" {
			continue
		}
		entry := object{"extensionId": value(p.id), "accessEnabled": value(p.access)}
		for _, key := range []string{"browserExtensionId", "browserName", "profileLabel"} {
			entry[key] = value[*string](nil)
			if v, ok := p.identity[key]; ok {
				entry[key] = v
			}
		}
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].text("extensionId") < result[j].text("extensionId") })
	return result
}

func (d *daemon) windows() {
	for p := range d.peers {
		if p.role != "extension" || !p.windowPush {
			continue
		}
		others := []object{}
		for other := range d.peers {
			if other == p || other.role != "extension" || !other.access {
				continue
			}
			entry := object{"extensionId": value(other.id), "browserName": value[*string](nil), "profileLabel": value[*string](nil), "window": value(other.window)}
			for _, key := range []string{"browserName", "profileLabel"} {
				if v := other.identity[key]; v != nil {
					entry[key] = v
				}
			}
			if other.windowControl {
				entry["canControl"] = value(true)
			}
			others = append(others, entry)
		}
		p.send(object{"type": value("extension.window_access"), "otherEnabledWindows": value(others)})
	}
}

func (d *daemon) handle(p *peer, message object) {
	d.initServices()
	kind := message.text("type")
	if kind == "agent.request" {
		d.route(p, message.object("request"))
		return
	}
	if kind == "register" {
		p.send(object{"type": value("registration_failed"), "error": value(object{"code": value("INVALID_REQUEST"), "message": value("Socket is already registered.")})})
		return
	}
	if p.role != "extension" {
		_ = p.conn.Close()
		return
	}
	switch kind {
	case "extension.response":
		d.response(p, message.object("response"))
	case "extension.identity":
		d.identity(p, message)
		d.windows()
	case "extension.access_update":
		p.access = message.boolean("accessEnabled")
		p.window = nil
		if p.access {
			p.window = normalizeEnabledWindow(message.object("enabledWindow"))
		} else {
			d.artifacts.cleanup("", "", p.id, false)
			d.recordings.disconnect(p.id)
			d.baselines.clear(p)
		}
		d.windows()
	case "extension.window_action.request", "extension.window_action.result":
		d.windowAction(p, message)
	case "extension.artifact.begin", "extension.artifact.chunk", "extension.artifact.commit":
		d.artifactMessage(p, message)
	case "extension.journal.begin", "extension.journal.append":
		d.journalMessage(p, message)
	case "log":
		d.pushServiceLog(message.object("entry"))
	case "extension.activity":
		p.active = time.Now().UnixMilli()
	case "extension.setup_status.request":
		status, err := setupStatus(d.config)
		if err != nil {
			p.send(object{"type": value("extension.setup_status.error"), "requestId": message["requestId"], "error": value(object{"message": value(err.Error())})})
		} else {
			p.send(object{"type": value("extension.setup_status.response"), "requestId": message["requestId"], "status": value(status)})
		}
	default:
		p.send(object{"type": value("error"), "error": value(object{"code": value("INVALID_REQUEST"), "message": value("Unknown message type.")})})
	}
}

func (d *daemon) health(result object) object {
	d.initServices()
	extensionRecovery := normalizeRecovery(result.object("recovery"), "routedExtension")
	result = normalizeExtensionHealth(result)
	result["daemon"] = value("ok")
	result["daemonVersion"] = value(version)
	result["daemonVersionName"] = value(versionName())
	result["daemon_supported_versions"] = value([]string{protocolVersion()})
	result["supported_versions"] = value([]string{protocolVersion()})
	result["protocol_version"] = value(protocolVersion())
	result["extensionConnected"] = value(len(d.snapshot()) > 0)
	result["connectedExtensions"] = value(d.snapshot())
	result["socketPath"] = value(d.config.address)
	result["transport"] = value(d.config.address)
	proxy := object{"enabled": value(false), "endpoint": value[*string](nil)}
	if d.config.network == "tcp" {
		host, _, err := net.SplitHostPort(d.config.bind)
		if err == nil && host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
			proxy["enabled"] = value(true)
			proxy["endpoint"] = value(d.config.bind)
		}
	}
	result["proxy"] = value(proxy)
	recovery := object{"daemon": value(d.telemetry.snapshot("daemon"))}
	if extensionRecovery != nil {
		recovery["routedExtension"] = value(extensionRecovery)
	}
	result["recovery"] = value(recovery)
	return result
}

func (d *daemon) route(p *peer, request object) {
	d.initServices()
	id, method := request.text("id"), request.text("method")
	params, err := optionalObject(request, "params")
	if !validID(id) || method == "" || err != nil {
		p.respond(failure(id, "INVALID_REQUEST", "Invalid bridge request."))
		return
	}
	if _, ok := catalog.Methods[method]; !ok {
		p.respond(failure(id, "INVALID_REQUEST", "Unknown bridge method: "+method))
		return
	}
	meta, err := optionalObject(request, "meta")
	if err != nil || (request["session_id"] != nil && !bytes.Equal(request["session_id"], []byte("null"))) {
		p.respond(failure(id, "INVALID_REQUEST", "Invalid bridge metadata."))
		return
	}
	request["params"] = value(params)
	normalizeDaemonRequestMeta(meta)
	request["meta"] = value(meta)
	for _, field := range []string{"target_extension", "target_browser", "target_profile"} {
		if _, exists := meta[field]; exists {
			text := meta.text(field)
			if !validText(text, 256) {
				p.respond(failure(id, "INVALID_REQUEST", "meta."+field+" must be a non-empty routing label without control characters."))
				return
			}
			meta[field] = value(strings.TrimSpace(text))
		}
	}
	if tab := request["tab_id"]; tab != nil && !bytes.Equal(tab, []byte("null")) && (request.number("tab_id") <= 0 || request.number("tab_id") > 9_007_199_254_740_991) {
		p.respond(failure(id, "INVALID_REQUEST", "tab_id must be a positive safe integer or null."))
		return
	}
	if !requestVersionPattern.MatchString(meta.text("protocol_version")) || strings.Split(meta.text("protocol_version"), ".")[0] != strings.Split(protocolVersion(), ".")[0] {
		p.respond(failure(id, "INVALID_REQUEST", "Client and daemon protocol majors differ."))
		return
	}
	if p.role == "extension" && method != "health.ping" && method != "setup.get_status" && method != "setup.install" {
		p.respond(failure(id, "ACCESS_DENIED", "Native-host requests are limited to health and local setup."))
		return
	}
	for _, pending := range d.pending {
		if pending.owner == p && pending.original == id {
			d.localResponse(p, request, failure(id, "INVALID_REQUEST", "Duplicate pending request id."))
			return
		}
	}
	if d.localService(p, request, params) {
		return
	}
	switch method {
	case "daemon.metrics":
		agents := 0
		for peer := range d.peers {
			if peer.role == "agent" {
				agents++
			}
		}
		d.baselines.prune()
		var uptime, average int64
		if !d.started.IsZero() {
			uptime = time.Since(d.started).Milliseconds()
		}
		if d.processed > 0 {
			average = (d.responseMillis + d.processed/2) / d.processed
		}
		d.localResponse(p, request, success(id, object{"uptimeMs": value(uptime), "activeAgents": value(agents), "pendingRequests": value(len(d.pending)), "activeExtensions": value(len(d.snapshot())), "requestsProcessed": value(d.processed), "requestsFailed": value(d.failed), "avgResponseTimeMs": value(average), "domBaselineOwners": value(len(d.baselines.owners)), "recovery": value(d.telemetry.snapshot("daemon"))}))
		return
	case "protocol.describe":
		d.localResponse(p, request, success(id, describe(params)))
		return
	case "skill.get_runtime_context":
		d.localResponse(p, request, success(id, catalog.Runtime))
		return
	case "log.tail":
		limit := int(serviceClampInt(params, "limit", 1, 200, 30))
		if limit > len(d.logs) {
			limit = len(d.logs)
		}
		d.localResponse(p, request, success(id, object{"entries": value(d.logs[len(d.logs)-limit:])}))
		return
	}
	candidates := []*peer{}
	for target := range d.peers {
		if target.role != "extension" || (meta.text("target_extension") != "" && meta.text("target_extension") != target.id) ||
			(meta.text("target_browser") != "" && meta.text("target_browser") != target.identity.text("browserName")) ||
			(meta.text("target_profile") != "" && meta.text("target_profile") != target.identity.text("profileLabel")) {
			continue
		}
		candidates = append(candidates, target)
	}
	if usesBaselineOwner(method) {
		if !baselineIDPattern.MatchString(params.text("baselineId")) {
			d.localResponse(p, request, failure(id, "INVALID_REQUEST", "baselineId is invalid."))
			return
		}
		d.baselines.prune()
		owner := d.baselines.owners[params.text("baselineId")].target
		matching := []*peer{}
		for _, target := range candidates {
			if target == owner && target.access {
				matching = append(matching, target)
			}
		}
		candidates = matching
		if len(candidates) == 0 {
			response := failure(id, "DOM_BASELINE_NOT_FOUND", "DOM baseline is missing, expired, released, or its browser destination disconnected.")
			err := response.object("error")
			err["details"] = value(object{"baselineId": params["baselineId"]})
			response["error"] = value(err)
			if method == "dom.baseline.release" {
				response = success(id, object{"baselineId": params["baselineId"], "released": value(false)})
			}
			d.localResponse(p, request, response)
			return
		}
	}
	if len(candidates) == 0 {
		if method == "health.ping" && meta.text("target_extension") == "" && meta.text("target_profile") == "" && meta.text("target_browser") == "" {
			d.localResponse(p, request, success(id, d.health(nil)))
		} else {
			response := failure(id, "EXTENSION_DISCONNECTED", "No connected extension matches the requested browser profile.")
			reason := "browser_target_disconnected"
			if meta.text("target_extension") == "" && meta.text("target_browser") == "" && meta.text("target_profile") == "" {
				reason = "extension_disconnected"
			}
			d.routingError(p, request, response, reason)
		}
		return
	}
	if len(candidates) > 1 && method != "health.ping" {
		d.routingError(p, request, failure(id, "TAB_MISMATCH", "Multiple browser profiles match. Select extensionId; tabId alone does not select a profile."), "ambiguous_browser_target")
		return
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.access != b.access {
			return a.access
		}
		if a.active != b.active {
			return a.active > b.active
		}
		return a.id < b.id
	})
	if len(d.pending) >= 128 || p.pending >= 16 {
		d.localResponse(p, request, failure(id, "INVALID_REQUEST", "Daemon pending-request limit reached."))
		return
	}
	// Remap request IDs on the daemon side so two agents may choose the same
	// identifier without stealing or cancelling each other's response.
	routedID := uniqueID()
	target := candidates[0]
	meta["transport_owner"] = value(p.owner)
	request["id"], request["meta"] = value(routedID), value(meta)
	pending := &pendingRequest{owner: p, target: target, original: id, method: method, baselineID: params.text("baselineId"), started: time.Now(), meta: meta}
	d.pending[routedID] = pending
	p.pending++
	duration := 30 * time.Second
	if timeout := params.number("timeoutMs"); timeout > 28_000 {
		if timeout > 120_000 {
			timeout = 120_000
		}
		duration = time.Duration(timeout+2_000) * time.Millisecond
	}
	pending.timer = time.AfterFunc(duration, func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.pending[routedID] == pending {
			d.baselines.abandon(routedID, pending)
			d.finish(routedID, failure(id, "TIMEOUT", "Extension did not respond in time. Inspect postconditions before retrying a mutation."))
		}
	})
	p.dataTargets[target] = true
	target.send(object{"type": value("extension.request"), "request": value(request)})
}

func (d *daemon) routingError(p *peer, request, response object, reason string) {
	err := response.object("error")
	err["details"] = value(object{"reason": value(reason), "connectedExtensions": value(d.snapshot())})
	if reason == "browser_target_disconnected" || reason == "ambiguous_browser_target" {
		err["recovery"] = value(object{"retry": value(false), "alternativeMethod": value("health.ping"), "hint": value("Discover connectedExtensions with health.ping or list enabled profiles with MCP tabs.list. Select extensionId and tabId for the intended page. Do not disable unrelated windows or fall back to another profile.")})
	}
	response["error"] = value(err)
	d.localResponse(p, request, response)
}

func (d *daemon) finish(id string, response object) {
	pending := d.pending[id]
	if pending == nil {
		return
	}
	pending.timer.Stop()
	delete(d.pending, id)
	pending.owner.pending--
	d.artifacts.cleanup(id, "", "", response.boolean("ok"))
	d.recordCompletion(pending, response.boolean("ok"))
	response["id"] = value(pending.original)
	meta := response.object("meta")
	if meta == nil {
		meta = object{}
	}
	meta["method"] = value(pending.method)
	meta["protocol_version"] = value(protocolVersion())
	response["meta"] = value(meta)
	protectResponseRecovery(response, pending.method)
	if response.boolean("ok") && pending.method == "dom.baseline.create" {
		result := response.object("result")
		release := func() {
			id := result.text("baselineId")
			if d.baselines.owners[id].target == pending.target {
				delete(d.baselines.owners, id)
			}
			if d.peers[pending.target] {
				d.releaseOrphan(pending.target, result)
			}
		}
		accepted := pending.owner.enqueue(object{"type": value("agent.response"), "response": value(response)}, func(ok bool) {
			if !ok {
				d.mu.Lock()
				defer d.mu.Unlock()
				release()
			}
		})
		if !accepted {
			release()
		}
	} else {
		pending.owner.respond(response)
	}
	entry := object{"at": value(time.Now().UTC().Format(time.RFC3339Nano)), "id": value(pending.original), "method": value(pending.method), "ok": value(response.boolean("ok")), "source": value[*string](nil)}
	if source := pending.meta.text("source"); source != "" {
		entry["source"] = value(source)
	}
	if era := pending.meta.text("mcp_era"); era != "" {
		entry["mcpEra"] = value(era)
	}
	d.pushServiceLog(entry)
}

func (d *daemon) response(p *peer, response object) {
	id := response.text("id")
	pending := d.pending[id]
	if pending == nil {
		if d.baselines.abandoned[id].target == p {
			delete(d.baselines.abandoned, id)
			if response.boolean("ok") {
				d.releaseOrphan(p, response.object("result"))
			}
		}
		return
	}
	if pending.target != p {
		return
	}
	if !bytes.Equal(response["ok"], []byte("true")) && !bytes.Equal(response["ok"], []byte("false")) {
		d.finish(id, failure(id, "INVALID_REQUEST", "Malformed extension response."))
		return
	}
	if response.boolean("ok") {
		if pending.localError != nil {
			d.finish(id, pending.localError)
			return
		}
		result := response.object("result")
		if result.text("delivery") == "artifact" && !d.artifacts.matches(result.object("artifact"), pending.owner.owner, id, artifactKind(pending.method)) {
			d.finish(id, failure(id, "ARTIFACT_TRANSFER_INVALID", "Artifact metadata does not match the request or was not committed before the response."))
			return
		}
		if pending.method == "health.ping" {
			// Health is reconstructed by the daemon. Extension cost estimates and
			// other response metadata describe the discarded extension envelope.
			response = success(id, d.health(response.object("result")))
		}
	}
	response = d.baselineResponse(p, pending, response)
	d.finish(id, response)
}

func (d *daemon) disconnect(p *peer) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.initServices()
	delete(d.peers, p)
	d.artifacts.cleanup("", p.owner, "", false)
	if p.role == "extension" {
		d.artifacts.cleanup("", "", p.id, false)
		d.recordings.disconnect(p.id)
		d.baselines.clear(p)
	}
	for id, action := range d.windowActions {
		if action.source == p || action.target == p {
			d.finishWindowAction(id, "The browser disconnected. Try again.")
		}
	}
	for id, pending := range d.pending {
		if pending.owner == p {
			d.baselines.abandon(id, pending)
			d.artifacts.cleanup(id, "", "", false)
			d.recordCompletion(pending, false)
			pending.timer.Stop()
			delete(d.pending, id)
			p.pending--
		} else if pending.target == p {
			d.finish(id, failure(pending.original, "EXTENSION_DISCONNECTED", "The selected browser profile disconnected."))
		}
	}
	for target := range p.dataTargets {
		if d.peers[target] {
			target.send(object{"type": value("extension.owner_disconnected"), "ownerId": value(p.owner)})
		}
	}
	for other := range d.peers {
		delete(other.dataTargets, p)
	}
	if p.role == "extension" {
		d.windows()
	}
}

func (d *daemon) initServices() {
	if d.artifacts == nil {
		d.artifacts = newArtifactStore(filepath.Join(d.config.home, "artifacts"))
	}
	if d.recordings == nil {
		d.recordings = newRecordingStore(filepath.Join(d.config.home, "recordings"))
	}
	if d.baselines == nil {
		d.baselines = newBaselineRegistry()
	}
	if d.windowActions == nil {
		d.windowActions = make(map[string]*pendingWindowAction)
	}
}

func (d *daemon) localResponse(p *peer, request, response object) {
	meta := response.object("meta")
	meta["method"] = request["method"]
	response["meta"] = value(meta)
	protectResponseRecovery(response, request.text("method"))
	if request.text("method") != "session.journal_read" && request.text("method") != "session.journal_delete" {
		d.recordOutcome(request.text("method"), request.object("meta"), response.boolean("ok"))
	}
	p.respond(response)
}

func (d *daemon) localService(p *peer, request, params object) bool {
	method, id := request.text("method"), request.text("id")
	if (method == "artifact.read" || method == "artifact.delete") && !artifactIDPattern.MatchString(params.text("artifactId")) {
		d.localResponse(p, request, failure(id, "INVALID_REQUEST", "artifactId is invalid."))
		return true
	}
	if method == "session.journal_read" || method == "session.journal_delete" {
		valid := recordingIDPattern.MatchString(params.text("journalId"))
		for key := range params {
			if key != "journalId" && (method != "session.journal_read" || (key != "offset" && key != "maxBytes")) {
				valid = false
			}
		}
		if !valid {
			d.localResponse(p, request, failure(id, "INVALID_REQUEST", "Invalid journal capability or parameters."))
			return true
		}
	}
	var result object
	var err error
	fallback := "INTERNAL_ERROR"
	switch method {
	case "setup.get_status":
		result, err = setupStatus(d.config)
	case "setup.install":
		if !localControlPeer(p) {
			err = serviceFailure("ACCESS_DENIED", "setup.install is restricted to local Browser Bridge clients.")
		} else {
			result, err = setupInstall(d.config, params)
		}
		fallback = "INVALID_REQUEST"
	case "artifact.delete":
		result, err = d.artifacts.delete(params.text("artifactId"), p.owner)
	case "artifact.read", "session.journal_read":
		offset, offsetOK := serviceInteger(params, "offset")
		limit, limitOK := serviceInteger(params, "maxBytes")
		if params["offset"] == nil || bytes.Equal(params["offset"], []byte("null")) {
			offset, offsetOK = 0, true
		}
		if params["maxBytes"] == nil || bytes.Equal(params["maxBytes"], []byte("null")) {
			limit, limitOK = artifactChunkBytes, true
		}
		if method == "artifact.read" {
			offset, limit = serviceClampInt(params, "offset", 0, artifactMaxBytes, 0), serviceClampInt(params, "maxBytes", 1, artifactChunkBytes, artifactChunkBytes)
			offsetOK, limitOK = true, true
		}
		if !offsetOK || !limitOK || offset < 0 || limit < 1 || limit > artifactChunkBytes {
			err = serviceFailure("INVALID_REQUEST", "Invalid read range.")
		} else if method == "artifact.read" {
			result, err = d.artifacts.read(params.text("artifactId"), p.owner, offset, limit)
		} else {
			result, err = d.recordings.read(params.text("journalId"), offset, limit)
			fallback = "ARTIFACT_NOT_FOUND"
		}
	case "session.journal_delete":
		result, err = d.recordings.delete(params.text("journalId"))
		fallback = "ARTIFACT_NOT_FOUND"
	default:
		return false
	}
	if err != nil && fallback == "ARTIFACT_NOT_FOUND" {
		var typed *serviceError
		if !errors.As(err, &typed) {
			err = serviceFailure("ARTIFACT_NOT_FOUND", "Recording journal unavailable.")
		}
	}
	d.localResponse(p, request, serviceResponse(id, result, err, fallback))
	return true
}

func localControlPeer(p *peer) bool {
	if p.role == "extension" {
		return true
	}
	if p.conn == nil {
		return false
	}
	addr := p.conn.RemoteAddr()
	if addr.Network() == "unix" || addr.Network() == "pipe" {
		return true
	}
	return false
}

package bridge

import (
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// A browser connected recently is probably reconnecting: its service
	// worker restarted, the native host relaunched, or the daemon was
	// replaced. Requests wait this long for it instead of failing at once.
	reconnectWaitWarm = 12 * time.Second
	// A disconnect older than this is not treated as a reconnect.
	reconnectWarmWindow = 2 * time.Minute
	maxParkedRequests   = 64
	// parkedUntilKey carries a parked request's deadline through re-routing.
	// route strips it before validation and dispatch.
	parkedUntilKey = "_bbx_parked_until_ms"
)

// parkedRequest is an agent request waiting for a browser to reconnect.
type parkedRequest struct {
	peer     *peer
	request  object
	response object
	reason   string
	timer    *time.Timer
}

// reconnectWait is how long a request may wait for a browser, or zero when no
// reconnect is expected and the caller should hear about it now. Only a
// browser seen recently counts: with none ever connected (no browser running,
// or a CLI call before Chrome starts) waiting would only delay the answer.
// BBX_RECONNECT_WAIT_MS overrides the wait; 0 disables it.
func (d *daemon) reconnectWait(now time.Time) time.Duration {
	if d.lastExtensionAt.IsZero() || now.Sub(d.lastExtensionAt) > reconnectWarmWindow {
		return 0
	}
	if override, ok := os.LookupEnv("BBX_RECONNECT_WAIT_MS"); ok {
		ms, err := strconv.Atoi(strings.TrimSpace(override))
		if err == nil && ms >= 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return reconnectWaitWarm
}

// parkForReconnect holds a request that found no browser while one is
// expected back. It re-routes when an extension registers or reports access,
// and fails with the original routing error at its deadline. Caller holds d.mu.
func (d *daemon) parkForReconnect(p *peer, request, response object, reason string, parkedUntil int64) bool {
	if reason != "extension_disconnected" && reason != "browser_target_disconnected" {
		return false
	}
	if len(d.parked) >= maxParkedRequests {
		return false
	}
	// With another browser still connected, a missing target is a routing
	// choice to report, not a reconnect to wait for.
	for other := range d.peers {
		if other.role == "extension" {
			return false
		}
	}
	now := time.Now()
	deadline := time.UnixMilli(parkedUntil)
	if parkedUntil <= 0 {
		wait := d.reconnectWait(now)
		if wait <= 0 {
			return false
		}
		deadline = now.Add(wait)
	}
	remaining := deadline.Sub(now)
	if remaining <= 0 {
		return false
	}
	request[parkedUntilKey] = value(deadline.UnixMilli())
	entry := &parkedRequest{peer: p, request: request, response: response, reason: reason}
	entry.timer = time.AfterFunc(remaining, func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if d.unpark(entry) && d.peers[entry.peer] {
			delete(entry.request, parkedUntilKey)
			d.routingError(entry.peer, entry.request, entry.response, entry.reason)
		}
	})
	d.parked = append(d.parked, entry)
	return true
}

// unpark removes one entry. Caller holds d.mu.
func (d *daemon) unpark(entry *parkedRequest) bool {
	for i, parked := range d.parked {
		if parked == entry {
			d.parked = append(d.parked[:i], d.parked[i+1:]...)
			entry.timer.Stop()
			return true
		}
	}
	return false
}

// retryParked re-routes every waiting request after a browser registered or
// changed access. Requests that still find no browser park again with their
// original deadline. Caller holds d.mu.
func (d *daemon) retryParked() {
	if len(d.parked) == 0 {
		return
	}
	waiting := d.parked
	d.parked = nil
	for _, entry := range waiting {
		entry.timer.Stop()
		if d.peers[entry.peer] {
			d.route(entry.peer, entry.request)
		}
	}
}

// dropParked forgets a disconnected agent's waiting requests, or one request
// it canceled. Caller holds d.mu.
func (d *daemon) dropParked(p *peer, requestID string) {
	kept := d.parked[:0]
	for _, entry := range d.parked {
		if entry.peer == p && (requestID == "" || entry.request.text("id") == requestID) {
			entry.timer.Stop()
			continue
		}
		kept = append(kept, entry)
	}
	d.parked = kept
}

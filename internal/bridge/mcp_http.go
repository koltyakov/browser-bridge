package bridge

import (
	"context"
	"crypto/sha256"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	mcpHTTPMaxOwners  = 64
	mcpHTTPMaxStreams = 64
)

type mcpHTTPOwner struct {
	session    *mcpSession
	credential string
	digest     [32]byte
	revision   string
	created    time.Time
	lastUsed   time.Time
	active     int
	calls      int
	streams    int
	eventsOpen bool
	pending    map[string]context.CancelFunc
	events     chan object
	ctx        context.Context
	cancel     context.CancelFunc
}

type mcpHTTPServer struct {
	config       config
	settings     mcpHTTPSettings
	listener     net.Listener
	server       *http.Server
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	owners       map[string]*mcpHTTPOwner
	closed       bool
	active       int
	streams      int
	workers      sync.WaitGroup
	stopped      chan struct{}
	maintained   chan struct{}
	nativeTokens [2]string
}

func startMCPHTTP(ctx context.Context, c config, settings mcpHTTPSettings) (*mcpHTTPServer, error) {
	if err := settings.validate(); err != nil {
		return nil, err
	}
	agent, _ := c.credential("agent")
	extension, _ := c.credential("extension")
	for _, path := range settings.Clients {
		token, _ := mcpHTTPCredential(path)
		if tokensEqual(token, agent) || tokensEqual(token, extension) {
			return nil, errors.New("MCP HTTP requires dedicated credentials, not native bridge credentials")
		}
	}
	listener, err := net.Listen("tcp", settings.Listen)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	h := &mcpHTTPServer{config: c, settings: settings, listener: listener, ctx: ctx, cancel: cancel, owners: make(map[string]*mcpHTTPOwner), stopped: make(chan struct{}), maintained: make(chan struct{}), nativeTokens: [2]string{agent, extension}}
	h.server = &http.Server{
		Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384,
	}
	go func() {
		defer close(h.stopped)
		err := h.server.Serve(listener)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.cancel()
		}
	}()
	go func() {
		defer close(h.maintained)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = h.server.Close()
				h.expire(time.Now(), true)
				return
			case now := <-ticker.C:
				h.expire(now, false)
			}
		}
	}()
	return h, nil
}

func (h *mcpHTTPServer) close() {
	h.mu.Lock()
	h.closed = true
	h.mu.Unlock()
	h.cancel()
	_ = h.server.Close()
	h.expire(time.Now(), true)
	<-h.stopped
	<-h.maintained
	h.workers.Wait()
}

func (h *mcpHTTPServer) dedicatedToken(token string) bool {
	for _, native := range h.nativeTokens {
		if tokensEqual(token, native) {
			return false
		}
	}
	return true
}

func (h *mcpHTTPServer) credentialCurrent(name string, digest [32]byte) bool {
	token, err := mcpHTTPCredential(h.settings.Clients[name])
	return err == nil && h.dedicatedToken(token) && sha256.Sum256([]byte(token)) == digest
}

func (h *mcpHTTPServer) expire(now time.Time, all bool) {
	h.mu.Lock()
	candidates := make(map[string]*mcpHTTPOwner, len(h.owners))
	for key, owner := range h.owners {
		candidates[key] = owner
	}
	h.mu.Unlock()
	for key, owner := range candidates {
		revoked := !all && !h.credentialCurrent(owner.credential, owner.digest)
		h.mu.Lock()
		expired := owner.ctx.Err() != nil || (owner.active == 0 && (now.Sub(owner.lastUsed) >= time.Duration(h.settings.IdleTimeoutSeconds)*time.Second || now.Sub(owner.created) >= time.Duration(h.settings.MaxLifetimeSeconds)*time.Second))
		remove := h.owners[key] == owner && (all || revoked || expired)
		if remove {
			delete(h.owners, key)
			owner.cancel()
		}
		h.mu.Unlock()
		if remove {
			owner.session.close()
		}
	}
}

func (h *mcpHTTPServer) owner(credential string, digest [32]byte, key, revision string, create bool) *mcpHTTPOwner {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.ctx.Err() != nil {
		return nil
	}
	owner := h.owners[key]
	if owner != nil && (owner.credential != credential || owner.digest != digest) {
		return nil
	}
	if owner != nil && (owner.ctx.Err() != nil || time.Since(owner.created) >= time.Duration(h.settings.MaxLifetimeSeconds)*time.Second || (owner.active == 0 && time.Since(owner.lastUsed) >= time.Duration(h.settings.IdleTimeoutSeconds)*time.Second)) {
		// Let admitted calls finish, but do not let overlapping new requests
		// keep a maximum-lifetime owner alive indefinitely. The sweeper closes
		// it once its active calls drain; no expired handle is revived here.
		return nil
	}
	if owner == nil && create && len(h.owners) < mcpHTTPMaxOwners {
		ctx, cancel := context.WithCancel(h.ctx)
		owner = &mcpHTTPOwner{
			session:    &mcpSession{config: h.config, enabled: make(map[string]bool), agentSession: "mcp_" + uniqueID(), daemonHosted: true},
			credential: credential, digest: digest, revision: revision, created: time.Now(), lastUsed: time.Now(),
			pending: make(map[string]context.CancelFunc), events: make(chan object, 32), ctx: ctx, cancel: cancel,
		}
		h.owners[key] = owner
	}
	if owner != nil {
		owner.active++
		owner.lastUsed = time.Now()
	}
	return owner
}

func (h *mcpHTTPServer) release(owner *mcpHTTPOwner) {
	h.mu.Lock()
	owner.active--
	owner.lastUsed = time.Now()
	h.mu.Unlock()
}

func (h *mcpHTTPServer) remove(key string, owner *mcpHTTPOwner) {
	h.mu.Lock()
	if h.owners[key] == owner {
		delete(h.owners, key)
	}
	owner.cancel()
	h.mu.Unlock()
	owner.session.close()
}

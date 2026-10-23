package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

type callResult struct {
	response object
	err      error
}

type client struct {
	conn                 net.Conn
	writer               wireWriter
	mu                   sync.Mutex
	pending              map[string]chan callResult
	closed               error
	supportsCancellation bool
}

func connect(c config, role string) (*client, error) {
	conn, reader, ack, err := registerConnection(c, role)
	if err != nil {
		return nil, err
	}
	cl := &client{conn: conn, writer: wireWriter{out: conn}, pending: make(map[string]chan callResult), supportsCancellation: ack.boolean("requestCancellation")}
	go cl.read(reader)
	return cl, nil
}

func register(c config, role string) (net.Conn, *bufio.Reader, error) {
	conn, reader, _, err := registerConnection(c, role)
	return conn, reader, err
}

func registerConnection(c config, role string) (net.Conn, *bufio.Reader, object, error) {
	conn, err := c.dial()
	if err != nil {
		return nil, nil, nil, err
	}
	token, err := c.credential(role)
	// Existing Node Unix-socket daemons rely on filesystem access and may not
	// have created credential files. TCP always requires credentials.
	if errors.Is(err, os.ErrNotExist) && c.network == "unix" {
		token, err = "", nil
	}
	if err != nil {
		_ = conn.Close()
		return nil, nil, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	w := wireWriter{out: conn}
	registration := protocol.BridgeRegistration{Type: "register", Role: role, AuthToken: protocol.Optional[string]{Value: token, Set: true}}
	if role == "agent" {
		registration.ClientId = protocol.Optional[string]{Value: "go_" + uniqueID(), Set: true}
	}
	message, err := decodeObject(value(registration))
	if err != nil {
		_ = conn.Close()
		return nil, nil, nil, err
	}
	if err := w.send(message); err != nil {
		_ = conn.Close()
		return nil, nil, nil, err
	}
	reader := bufio.NewReader(conn)
	reply, err := readLine(reader)
	if err == nil && (reply.text("type") != "registered" || reply.text("role") != role) {
		err = fmt.Errorf("bridge registration failed: %s", reply.object("error").text("message"))
	}
	if err != nil {
		_ = conn.Close()
		return nil, nil, nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, reader, reply, nil
}

func (c *client) read(reader *bufio.Reader) {
	for {
		message, err := readLine(reader)
		if err != nil {
			c.fail(err)
			return
		}
		if message.text("type") != "agent.response" {
			continue
		}
		response := message.object("response")
		c.mu.Lock()
		ch := c.pending[response.text("id")]
		delete(c.pending, response.text("id"))
		c.mu.Unlock()
		if ch != nil {
			ch <- callResult{response: response}
		}
	}
}

func (c *client) fail(err error) {
	_ = c.conn.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed != nil {
		return
	}
	c.closed = err
	for id, ch := range c.pending {
		ch <- callResult{err: err}
		delete(c.pending, id)
	}
}

func (c *client) close() { c.fail(errors.New("bridge client closed")) }

func protocolVersion() string {
	parts := strings.Split(version, ".")
	if len(parts) < 2 {
		return "0.0"
	}
	return strings.Join(parts[:2], ".")
}

func newRequest(method string, params, meta object, tab int64) object {
	if meta == nil {
		meta = object{}
	}
	if params == nil {
		params = object{}
	}
	metadata := protocol.BridgeRequestMeta{ProtocolVersion: protocolVersion(), Extra: meta}
	if budget := meta["token_budget"]; budget != nil {
		_ = json.Unmarshal(budget, &metadata.TokenBudget)
	}
	request, _ := decodeObject(value(protocol.BridgeRequest{
		ID:     uniqueID(),
		Method: protocol.BridgeMethod(method),
		Params: protocol.BridgeParams(params),
		Meta:   metadata,
		TabID:  protocol.Nullable[float64]{Value: float64(tab), Valid: tab > 0},
	}))
	return request
}

// A timed-out mutation is never retried. Connection errors after dispatch are
// surfaced to the caller, who must inspect postconditions before acting again.
func (c *client) request(ctx context.Context, request object) (object, error) {
	if request.text("method") == "page.extract_content" {
		response, err := extractContentRequest(ctx, request.object("params"), func(ctx context.Context, method string, params object) (object, error) {
			meta := object{}
			for key, entry := range request.object("meta") {
				meta[key] = entry
			}
			// Extraction needs the full bounded snapshot, not the caller's final
			// text budget. Keep profile routing and connection ownership intact.
			if method == "dom.get_html" {
				delete(meta, "token_budget")
			}
			return c.request(ctx, newRequest(method, params, meta, request.number("tab_id")))
		})
		if response != nil {
			response["id"] = request["id"]
		}
		return response, err
	}
	id := request.text("id")
	if id == "" {
		return nil, errors.New("request id is required")
	}
	ch := make(chan callResult, 1)
	c.mu.Lock()
	if c.closed != nil {
		err := c.closed
		c.mu.Unlock()
		return nil, err
	}
	if _, exists := c.pending[id]; exists {
		c.mu.Unlock()
		return nil, errors.New("duplicate request id")
	}
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.pending[id] == ch {
			delete(c.pending, id)
		}
		c.mu.Unlock()
	}()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if dispatched, err := c.writer.sendContext(ctx, object{"type": value("agent.request"), "request": value(request)}); err != nil {
		if dispatched {
			// A partial frame cannot safely share the transport with later calls.
			c.fail(err)
		}
		return nil, err
	}
	select {
	case result := <-ch:
		return result.response, result.err
	case <-ctx.Done():
		if !c.supportsCancellation {
			return nil, ctx.Err()
		}
		cancelCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if dispatched, err := c.writer.sendContext(cancelCtx, object{"type": value("agent.cancel"), "requestId": value(id)}); err != nil && dispatched {
			c.fail(err)
		}
		return nil, ctx.Err()
	}
}

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/websocket"
)

type devTools struct {
	socket *websocket.Conn
	id     int
}

func (c *devTools) command(ctx context.Context, method string, params json.RawMessage, session string) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(5 * time.Second)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	if err := c.socket.SetDeadline(deadline); err != nil {
		return nil, err
	}
	c.id++
	request := struct {
		ID        int             `json:"id"`
		Method    string          `json:"method"`
		Params    json.RawMessage `json:"params,omitempty"`
		SessionID string          `json:"sessionId,omitempty"`
	}{c.id, method, params, session}
	if err := websocket.JSON.Send(c.socket, request); err != nil {
		return nil, err
	}
	for {
		var response struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := websocket.JSON.Receive(c.socket, &response); err != nil {
			return nil, err
		}
		if response.ID != c.id {
			continue
		}
		if len(response.Error) > 0 && string(response.Error) != "null" {
			return nil, fmt.Errorf("%s: %s", method, response.Error)
		}
		return response.Result, nil
	}
}

func (c *devTools) evaluate(ctx context.Context, expression, session string) (json.RawMessage, error) {
	params, err := json.Marshal(struct {
		Expression    string `json:"expression"`
		AwaitPromise  bool   `json:"awaitPromise"`
		ReturnByValue bool   `json:"returnByValue"`
	}{expression, true, true})
	if err != nil {
		return nil, err
	}
	data, err := c.command(ctx, "Runtime.evaluate", params, session)
	if err != nil {
		return nil, err
	}
	var result struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		Exception json.RawMessage `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	if len(result.Exception) > 0 && string(result.Exception) != "null" {
		return nil, fmt.Errorf("extension evaluation failed: %s", result.Exception)
	}
	return result.Result.Value, nil
}

func privatePort() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	_, port, err := net.SplitHostPort(listener.Addr().String())
	closeErr := listener.Close()
	return port, errors.Join(err, closeErr)
}

func (r *arcRunner) connectEndpoint(ctx context.Context) (json.RawMessage, error) {
	// Recheck immediately before the first network operation, not just before
	// reporting the isolation stage. A removed or changed proof fails closed.
	if _, err := r.sources.verifyIsolation(ctx, r.selected); err != nil {
		return nil, err
	}
	u, err := url.Parse(r.selected.URL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+u.Host+"/json/version", nil)
	if err != nil {
		return nil, err
	}
	// Never use proxies or follow a loopback endpoint's redirects elsewhere.
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK || len(data) > 65536 {
		return nil, errors.New("DevTools version response is unsuccessful or oversized")
	}
	var version struct {
		Endpoint string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(data, &version); err != nil {
		return nil, err
	}
	if version.Endpoint != r.selected.URL {
		return nil, errors.New("HTTP version endpoint does not match the isolated browser endpoint")
	}
	config, err := websocket.NewConfig(r.selected.URL, "http://127.0.0.1")
	if err != nil {
		return nil, err
	}
	ws, err := config.DialContext(ctx)
	if err != nil {
		return nil, err
	}
	r.client = &devTools{socket: ws}
	ws.MaxPayloadBytes = 1024 * 1024
	versionData, err := r.client.command(ctx, "Browser.getVersion", nil, "")
	if err != nil {
		return versionData, err
	}
	var browser struct {
		Product string `json:"product"`
	}
	if err := json.Unmarshal(versionData, &browser); err != nil {
		return nil, err
	}
	if browser.Product == "" {
		return versionData, errors.New("DevTools did not return a browser version")
	}
	return versionData, nil
}

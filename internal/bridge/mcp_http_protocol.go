package bridge

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func mcpHTTPError(w http.ResponseWriter, status int, id json.RawMessage, code int, message string) {
	mcpHTTPJSON(w, status, rpcError(id, code, message))
}

func mcpHTTPJSON(w http.ResponseWriter, status int, message object) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(5 * time.Second))
	w.WriteHeader(status)
	_, _ = w.Write(value(message))
}

func (h *mcpHTTPServer) validAuthority(authority string) bool {
	host, port, err := net.SplitHostPort(authority)
	if err != nil || port != strconv.Itoa(h.listener.Addr().(*net.TCPAddr).Port) {
		return false
	}
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

func (h *mcpHTTPServer) validOrigin(r *http.Request) bool {
	if !h.validAuthority(r.Host) {
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	origin, err := url.Parse(origins[0])
	return err == nil && origin.Scheme == "http" && origin.User == nil && origin.RawQuery == "" && origin.Fragment == "" && origin.Path == "" && h.validAuthority(origin.Host)
}

func mcpHTTPAccept(r *http.Request, required ...string) bool {
	found := make(map[string]bool)
	for _, part := range strings.Split(r.Header.Get("Accept"), ",") {
		media, params, err := mime.ParseMediaType(strings.TrimSpace(part))
		quality := 1.0
		if raw := params["q"]; raw != "" {
			quality, err = strconv.ParseFloat(raw, 64)
		}
		if err == nil && quality > 0 && quality <= 1 {
			found[media] = true
		}
	}
	for _, media := range required {
		if !found[media] {
			return false
		}
	}
	return true
}

func mcpHTTPMessage(w http.ResponseWriter, r *http.Request) (object, bool) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		mcpHTTPError(w, http.StatusUnsupportedMediaType, nil, -32600, "Content-Type must be application/json.")
		return nil, false
	}
	if !mcpHTTPAccept(r, "application/json", "text/event-stream") {
		mcpHTTPError(w, http.StatusNotAcceptable, nil, -32600, "Accept must include application/json and text/event-stream.")
		return nil, false
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMessageBytes))
	if err != nil {
		var oversized *http.MaxBytesError
		status := http.StatusBadRequest
		if errors.As(err, &oversized) {
			status = http.StatusRequestEntityTooLarge
		}
		mcpHTTPError(w, status, nil, -32600, "Could not read a bounded MCP request.")
		return nil, false
	}
	message, err := decodeObject(data)
	if err != nil {
		code := -32600
		if !json.Valid(data) {
			code = -32700
		}
		mcpHTTPError(w, http.StatusBadRequest, nil, code, "Expected one JSON-RPC object.")
		return nil, false
	}
	id := message["id"]
	var number json.Number
	validID := id == nil || mcpIsString(id) || (string(id) != "null" && json.Unmarshal(id, &number) == nil)
	if message.text("jsonrpc") != "2.0" || message.text("method") == "" || !validID || (message["params"] != nil && message.object("params") == nil) {
		mcpHTTPError(w, http.StatusBadRequest, nil, -32600, "Invalid JSON-RPC request.")
		return nil, false
	}
	return message, true
}

func mcpHTTPHeaderValue(raw string) (string, bool) {
	if strings.HasPrefix(raw, "=?base64?") && strings.HasSuffix(raw, "?=") {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(strings.TrimPrefix(raw, "=?base64?"), "?="))
		return string(decoded), err == nil
	}
	return raw, true
}

func mcpHTTPModern(w http.ResponseWriter, r *http.Request, message object) bool {
	id, method := message["id"], message.text("method")
	params := message.object("params")
	meta := params.object("_meta")
	version := meta.text(versionKey)
	name, encoded := mcpHTTPHeaderValue(r.Header.Get("Mcp-Name"))
	expectedName := ""
	named := false
	switch method {
	case "tools/call", "prompts/get":
		named, expectedName = true, params.text("name")
	case "resources/read":
		named, expectedName = true, params.text("uri")
	}
	if len(r.Header.Values("MCP-Protocol-Version")) != 1 || len(r.Header.Values("Mcp-Method")) != 1 || r.Header.Get("MCP-Protocol-Version") == "" || r.Header.Get("MCP-Protocol-Version") != version || r.Header.Get("Mcp-Method") != method || (named && (len(r.Header.Values("Mcp-Name")) != 1 || !encoded || name != expectedName || r.Header.Get("Mcp-Name") == "")) {
		mcpHTTPError(w, http.StatusBadRequest, id, -32020, "Required HTTP metadata is missing or does not match the request body.")
		return false
	}
	if version != modernVersion {
		response := rpcError(id, -32022, "Unsupported protocol version")
		bridgeError := response.object("error")
		bridgeError["data"] = value(object{"supported": value([]string{modernVersion, "2025-11-25", "2025-06-18", "2025-03-26"}), "requested": value(version)})
		response["error"] = value(bridgeError)
		mcpHTTPJSON(w, http.StatusBadRequest, response)
		return false
	}
	if _, err := decodeObject(meta[capabilitiesKey]); err != nil {
		mcpHTTPError(w, http.StatusBadRequest, id, -32602, "Per-request clientCapabilities must be an object.")
		return false
	}
	return true
}

func mcpHTTPLegacyVersion(version string) bool {
	return version == "2025-03-26" || version == "2025-06-18" || version == "2025-11-25"
}

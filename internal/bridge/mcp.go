package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"time"
)

const modernVersion = "2026-07-28"
const versionKey = "io.modelcontextprotocol/protocolVersion"
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities"

type mcpSession struct {
	config       config
	mu           sync.Mutex
	client       *client
	clients      map[string]*client
	connecting   map[string]*mcpConnecting
	clientID     string
	enabled      map[string]bool
	agentSession string
	closed       bool
}

func rpcError(id json.RawMessage, code int, message string) object {
	return object{"jsonrpc": value("2.0"), "id": id, "error": value(object{"code": value(code), "message": value(message)})}
}

func rpcResult(id json.RawMessage, result object) object {
	return object{"jsonrpc": value("2.0"), "id": id, "result": value(result)}
}

func mcpRPCResult(id json.RawMessage, method, era string, result object) object {
	if era == "modern" {
		result = mcpClone(result)
		result["resultType"] = value("complete")
		result["_meta"] = value(object{"io.modelcontextprotocol/serverInfo": value(object{"name": value("browser-bridge"), "version": value(version)})})
		if method == "tools/list" || method == "server/discover" {
			result["ttlMs"], result["cacheScope"] = value(0), value("private")
		}
	}
	return rpcResult(id, result)
}

func toolResult(response object, err error) object {
	if err != nil {
		return mcpErrorResult("INTERNAL_ERROR", err.Error())
	}
	return response
}

func mcpServe(ctx context.Context, c config, input io.Reader, output io.Writer) error {
	s := &mcpSession{config: c, enabled: make(map[string]bool), agentSession: os.Getenv("BBX_SESSION")}
	if s.agentSession == "" {
		s.agentSession = "mcp_" + uniqueID()
	}
	writer := &wireWriter{out: output}
	reader := lineReader(input)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	disposeControl := startMCPControl(c, cancel)
	defer disposeControl()
	var workers sync.WaitGroup
	defer func() {
		cancel()
		s.mu.Lock()
		s.closed = true
		for _, cl := range s.clients {
			cl.close()
		}
		s.mu.Unlock()
		workers.Wait()
	}()
	// Closing inherited stdin does not reliably interrupt an OS-level read.
	// Keep reads off the serving goroutine so an authenticated restart can
	// return and let the host launch a new process even while stdin is idle.
	type incoming struct {
		message object
		err     error
	}
	messages := make(chan incoming)
	go func() {
		for {
			message, err := readLine(reader)
			select {
			case messages <- incoming{message, err}:
			case <-ctx.Done():
				return
			}
			if errors.Is(err, io.EOF) {
				return
			}
		}
	}()
	semaphore := make(chan struct{}, 16)
	var pendingMu sync.Mutex
	pending := make(map[string]context.CancelFunc)
	subscriptions := make(mcpSubscriptions)
	defer subscriptions.close(writer)
	era := ""
	modernProbe := false
	for {
		var message object
		var err error
		select {
		case next := <-messages:
			message, err = next.message, next.err
		case <-ctx.Done():
			return nil
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				clear(subscriptions)
			}
			if errors.Is(err, io.EOF) || ctx.Err() != nil {
				return nil
			}
			var syntax *json.SyntaxError
			var shape *json.UnmarshalTypeError
			if errors.As(err, &syntax) {
				_ = writer.send(rpcError(value[*int](nil), -32700, "Parse error."))
				continue
			}
			if errors.As(err, &shape) || err.Error() == "expected a JSON object" {
				_ = writer.send(rpcError(value[*int](nil), -32600, "Invalid JSON-RPC request."))
				continue
			}
			return err
		}
		id := message["id"]
		method := message.text("method")
		params := message.object("params")
		if id == nil {
			if method == "notifications/cancelled" {
				if subscriptions.cancel(params["requestId"]) {
					continue
				}
				pendingMu.Lock()
				if cancel := pending[string(params["requestId"])]; cancel != nil {
					cancel()
				}
				pendingMu.Unlock()
			}
			continue
		}
		if message.text("jsonrpc") != "2.0" || method == "" {
			_ = writer.send(rpcError(id, -32600, "Invalid JSON-RPC request."))
			continue
		}
		envelope := params.object("_meta")
		claimed := envelope.text(versionKey)
		if modernProbe && method == "initialize" && envelope[versionKey] == nil {
			era, modernProbe = "", false
		}
		if _, present := envelope[versionKey]; present || era == "modern" {
			if claimed != modernVersion {
				_ = writer.send(rpcError(id, -32602, "Expected the per-request MCP 2026-07-28 protocolVersion envelope."))
				continue
			}
			if _, err := decodeObject(envelope[capabilitiesKey]); err != nil {
				_ = writer.send(rpcError(id, -32602, "The per-request clientCapabilities object is required."))
				continue
			}
			if era == "legacy" {
				_ = writer.send(rpcError(id, -32602, "Cannot change protocol eras on an existing stdio connection."))
				continue
			}
			wasUnpinned := era == "" || modernProbe
			era = "modern"
			modernProbe = wasUnpinned && method == "server/discover"
		}
		if method == "initialize" && era != "modern" {
			if era != "" {
				_ = writer.send(rpcError(id, -32600, "Already initialized."))
				continue
			}
			revision := params.text("protocolVersion")
			switch revision {
			case "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25":
			default:
				revision = "2025-11-25"
			}
			era = "legacy"
			_ = writer.send(rpcResult(id, object{"protocolVersion": value(revision), "serverInfo": value(object{"name": value("browser-bridge"), "version": value(version)}), "capabilities": value(object{"tools": value(object{"listChanged": value(true)})}), "instructions": value(mcpCatalogData().LegacyInstructions)}))
			continue
		}
		if era == "" {
			_ = writer.send(rpcError(id, -32600, "Initialize the legacy connection or send the modern per-request envelope."))
			continue
		}
		switch method {
		case "subscriptions/listen":
			if era != "modern" {
				_ = writer.send(rpcError(id, -32601, "Method not found: "+method))
				continue
			}
			_ = writer.send(subscriptions.listen(id, params))
		case "server/discover":
			if era != "modern" {
				_ = writer.send(rpcError(id, -32601, "Method not found: "+method))
				continue
			}
			_ = writer.send(mcpRPCResult(id, method, era, object{"supportedVersions": value([]string{modernVersion}), "capabilities": value(object{"tools": value(object{"listChanged": value(true)})}), "instructions": value(catalog.Instructions)}))
		case "ping":
			_ = writer.send(mcpRPCResult(id, method, era, object{}))
		case "tools/list":
			_ = writer.send(mcpRPCResult(id, method, era, object{"tools": value(s.tools(era))}))
		case "tools/call":
			name := params.text("name")
			var schema object
			for _, tool := range s.tools(era) {
				if tool.text("name") == name {
					schema = tool.object("inputSchema")
				}
			}
			if schema == nil {
				_ = writer.send(rpcError(id, -32602, "Unknown tool: "+name))
				continue
			}
			arguments, err := decodeObject(params["arguments"])
			if params["arguments"] == nil {
				arguments, err = object{}, nil
			}
			if err != nil {
				_ = writer.send(rpcError(id, -32602, "Tool arguments must be an object."))
				continue
			}
			if err := validateSchema(value(arguments), schema, "arguments"); err != nil {
				_ = writer.send(rpcError(id, -32602, err.Error()))
				continue
			}
			if name == "browser_toolset" {
				tool := arguments.text("tool")
				newly := !s.enabled[tool]
				s.enabled[tool] = true
				text := tool + " is already loaded."
				if newly {
					text = "Loaded " + tool + "."
				}
				_ = writer.send(rpcResult(id, mcpResult(text, object{"tool": value(tool), "newlyEnabled": value(newly)}, false)))
				if newly {
					_ = writer.send(object{"jsonrpc": value("2.0"), "method": value("notifications/tools/list_changed")})
				}
				continue
			}
			select {
			case semaphore <- struct{}{}:
			default:
				_ = writer.send(rpcError(id, -32603, "Too many concurrent MCP requests."))
				continue
			}
			callCtx, callCancel := context.WithTimeout(ctx, 124*time.Second)
			pendingMu.Lock()
			if _, duplicate := pending[string(id)]; duplicate {
				pendingMu.Unlock()
				callCancel()
				<-semaphore
				_ = writer.send(rpcError(id, -32600, "Duplicate active request id."))
				continue
			}
			pending[string(id)] = callCancel
			pendingMu.Unlock()
			workers.Add(1)
			go func(era string) {
				defer workers.Done()
				defer callCancel()
				defer func() {
					<-semaphore
					pendingMu.Lock()
					delete(pending, string(id))
					pendingMu.Unlock()
				}()
				response, err := s.tool(callCtx, name, arguments, era)
				if err := writer.send(mcpRPCResult(id, "tools/call", era, toolResult(response, err))); err != nil {
					cancel()
				}
			}(era)
		default:
			_ = writer.send(rpcError(id, -32601, "Method not found: "+method))
		}
	}
}

func (s *mcpSession) tool(ctx context.Context, name string, args object, era string) (object, error) {
	return s.handleTool(ctx, name, args, era)
}

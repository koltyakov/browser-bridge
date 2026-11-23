package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"sync"
	"time"

	"github.com/koltyakov/browser-bridge/internal/protocol"
)

const modernVersion = "2026-07-28"
const versionKey = "io.modelcontextprotocol/protocolVersion"
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities"

type mcpSession struct {
	config                config
	mu                    sync.Mutex
	client                *client
	clients               map[string]*client
	connecting            map[string]*mcpConnecting
	clientID              string
	enabled               map[string]bool
	agentSession          string
	conversationNamespace string
	caller                *protocol.BridgeCaller
	closed                bool
	daemonHosted          bool
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
	if isDaemonUnavailable(err) {
		// Nothing was sent, so this is safe to retry, unlike a lost connection.
		return mcpResponse(failure("", "DAEMON_UNAVAILABLE", err.Error()+". Nothing was sent to the browser; retry, and if it persists run bbx doctor."), "", nil)
	}
	if err != nil {
		// A local cancellation, timeout, or transport failure can race with
		// browser dispatch. There is no confirmed bridge result here, so the
		// code's generic retry hint is unsafe, even after a clean MCP EOF.
		// Do not invent dispatch state or partial progress from a local error.
		failed := failure("", "INTERNAL_ERROR", err.Error())
		bridgeError := failed.object("error")
		bridgeError["details"] = value(object{"outcomeUncertain": value(true)})
		bridgeError["recovery"] = value(object{
			"retry": value(false),
			"hint":  value("No confirmed result is available. Actions may already have executed. Inspect current state before another deliberate action; do not replay automatically."),
		})
		failed["error"] = value(bridgeError)
		return mcpResponse(failed, "", nil)
	}
	return response
}

func mcpWriteToolResult(writer *wireWriter, id json.RawMessage, era string, result object) error {
	payload, err := mcpToolPayload(id, era, result)
	if err != nil {
		return err
	}
	_, err = writer.sendPayloadContext(context.Background(), payload)
	return err
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
		s.close()
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
			if skipErr := skipOversizedLine(reader, err); skipErr != nil && !errors.Is(skipErr, io.EOF) {
				err = skipErr
			}
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
			var oversized *oversizedLineError
			if errors.As(err, &oversized) {
				_ = writer.send(rpcError(value[*int](nil), -32600, "Request exceeds the 1 MiB message limit."))
				continue
			}
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
			s.caller = reportedCaller(params.object("clientInfo"))
			_ = writer.send(rpcResult(id, mcpInitializeResult(revision)))
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
			_ = writer.send(mcpRPCResult(id, method, era, mcpDiscoverResult()))
		case "ping":
			_ = writer.send(mcpRPCResult(id, method, era, object{}))
		case "tools/list":
			_ = writer.send(mcpRPCResult(id, method, era, object{"tools": value(s.tools(era))}))
		case "tools/call":
			requestCtx, name, arguments, invalid := s.prepareCall(ctx, params, era)
			if invalid != nil {
				invalid["id"] = id
				_ = writer.send(invalid)
				continue
			}
			if name == "browser_toolset" {
				result, newly := s.enableTool(arguments.text("tool"))
				_ = writer.send(rpcResult(id, result))
				if newly {
					_ = writer.send(object{"jsonrpc": value("2.0"), "method": value("notifications/tools/list_changed")})
				}
				continue
			}
			select {
			case semaphore <- struct{}{}:
			default:
				// A busy tool result, not a protocol error: the agent sees the
				// retry hint instead of a generic internal failure.
				_ = mcpWriteToolResult(writer, id, era, mcpResponse(failure("", "BRIDGE_BUSY", "Too many concurrent MCP tool calls in this session. Nothing was sent; retry after a running call finishes."), "", nil))
				continue
			}
			callCtx, callCancel := context.WithTimeout(requestCtx, 124*time.Second)
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
				if err := mcpWriteToolResult(writer, id, era, toolResult(response, err)); err != nil {
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

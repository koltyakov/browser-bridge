package bridge

import (
	"context"
	"encoding/json"
)

// Transport adapters share tool validation and dispatch, not connection state.
func (s *mcpSession) prepareCall(ctx context.Context, params object, era string) (context.Context, string, object, object) {
	envelope := params.object("_meta")
	if params["_meta"] != nil && envelope == nil {
		return ctx, "", nil, rpcError(nil, -32602, "Tool request _meta must be an object.")
	}
	requestCtx, err := s.conversationContext(ctx, envelope)
	if err != nil {
		return ctx, "", nil, rpcError(nil, -32602, err.Error())
	}
	name := params.text("name")
	var schema object
	for _, tool := range s.tools(era) {
		if tool.text("name") == name {
			schema = tool.object("inputSchema")
		}
	}
	if schema == nil {
		return ctx, "", nil, rpcError(nil, -32602, "Unknown tool: "+name)
	}
	arguments, err := decodeObject(params["arguments"])
	if params["arguments"] == nil {
		arguments, err = object{}, nil
	}
	if err != nil {
		return ctx, "", nil, rpcError(nil, -32602, "Tool arguments must be an object.")
	}
	if err := validateSchema(value(arguments), schema, "arguments"); err != nil {
		return ctx, "", nil, rpcError(nil, -32602, err.Error())
	}
	return s.callerContext(requestCtx, era, envelope), name, arguments, nil
}

func (s *mcpSession) enableTool(tool string) (object, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	newly := !s.enabled[tool]
	s.enabled[tool] = true
	text := tool + " is already loaded."
	if newly {
		text = "Loaded " + tool + "."
	}
	return mcpResult(text, object{"tool": value(tool), "newlyEnabled": value(newly)}, false), newly
}

func (s *mcpSession) close() {
	s.mu.Lock()
	s.closed = true
	clients := s.clients
	s.clients = nil
	s.mu.Unlock()
	for _, cl := range clients {
		cl.close()
	}
}

func mcpInitializeResult(revision string) object {
	return object{"protocolVersion": value(revision), "serverInfo": value(object{"name": value("browser-bridge"), "version": value(version)}), "capabilities": value(object{"tools": value(object{"listChanged": value(true)})}), "instructions": value(mcpCatalogData().LegacyInstructions)}
}

func mcpDiscoverResult() object {
	return object{"supportedVersions": value([]string{modernVersion}), "capabilities": value(object{"tools": value(object{"listChanged": value(true)})}), "instructions": value(catalog.Instructions)}
}

func mcpToolPayload(id json.RawMessage, era string, result object) ([]byte, error) {
	payload, err := encodeJSON(mcpRPCResult(id, "tools/call", era, result))
	if err != nil || len(payload) <= maxMessageBytes {
		return payload, err
	}
	result = mcpErrorResult("RESULT_TOO_LARGE", "MCP tool output exceeds 1 MiB. The call has already executed.", "Narrow read-only results or split the batch into smaller calls. Inspect postconditions before repeating actions.")
	return encodeJSON(mcpRPCResult(id, "tools/call", era, result))
}

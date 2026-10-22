package bridge

import "encoding/json"

const mcpSubscriptionIDKey = "io.modelcontextprotocol/subscriptionId"

// The SDK's stdio router holds listen requests open. Acknowledgment is a
// notification, client cancellation is silent, and graceful server shutdown
// completes each remaining request. Browser Bridge advertises tools changes
// only; modern tools are fixed, so there are no subsequent change events.
type mcpSubscriptions map[string]json.RawMessage

func (subscriptions mcpSubscriptions) listen(id json.RawMessage, params object) object {
	if len(subscriptions) >= 1024 {
		return rpcError(id, -32603, "Subscription limit reached")
	}
	filter, err := decodeObject(params["notifications"])
	valid := err == nil
	for _, key := range []string{"toolsListChanged", "promptsListChanged", "resourcesListChanged"} {
		if raw := filter[key]; raw != nil && string(raw) != "true" && string(raw) != "false" {
			valid = false
		}
	}
	if raw := filter["resourceSubscriptions"]; raw != nil {
		var entries []json.RawMessage
		if json.Unmarshal(raw, &entries) != nil || entries == nil {
			valid = false
		}
		for _, entry := range entries {
			if !mcpIsString(entry) {
				valid = false
			}
		}
	}
	if !valid {
		return rpcError(id, -32602, "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter")
	}
	honored := object{}
	if filter.boolean("toolsListChanged") {
		honored["toolsListChanged"] = value(true)
	}
	subscriptions[string(id)] = id
	return object{"jsonrpc": value("2.0"), "method": value("notifications/subscriptions/acknowledged"), "params": value(object{"notifications": value(honored), "_meta": value(object{mcpSubscriptionIDKey: id})})}
}

func (subscriptions mcpSubscriptions) cancel(id json.RawMessage) bool {
	_, exists := subscriptions[string(id)]
	delete(subscriptions, string(id))
	return exists
}

func (subscriptions mcpSubscriptions) close(writer *wireWriter) {
	for key, id := range subscriptions {
		_ = writer.send(rpcResult(id, object{"resultType": value("complete"), "_meta": value(object{mcpSubscriptionIDKey: id, "io.modelcontextprotocol/serverInfo": value(object{"name": value("browser-bridge"), "version": value(version)})})}))
		delete(subscriptions, key)
	}
}

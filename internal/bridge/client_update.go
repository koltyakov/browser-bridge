package bridge

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"
)

type compatibleNativeUpdate func(context.Context, config, string, []string) (object, error)

// Update checks run before dispatching a CLI command or starting an MCP session.
// No browser action is replayed after an update, and remote destinations never
// cause local installation changes.
func checkNativeClientUpdate(ctx context.Context, c config, health object, update compatibleNativeUpdate) (object, error) {
	if c.remote || !health.boolean("extensionConnected") {
		return object{"updated": value(false)}, nil
	}
	var supported []string
	if err := json.Unmarshal(health["extension_supported_versions"], &supported); err != nil || len(supported) == 0 {
		_ = json.Unmarshal(health["supported_versions"], &supported)
	}
	if len(supported) == 0 || health.text("extensionVersion") == "" {
		return object{"updated": value(false)}, nil
	}
	return update(ctx, c, health.text("extensionVersion"), supported)
}

func prepareNativeClient(ctx context.Context, c config, args []string) (bool, error) {
	if c.remote || npmManagedRuntime() {
		return false, nil
	}
	policy, err := updateReadPolicy(c)
	if err != nil || policy != "compatible" {
		return false, err
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cl, err := connect(c, "agent")
	if err != nil {
		return false, nil
	}
	healthCtx, stop := context.WithTimeout(ctx, 5*time.Second)
	response, err := cl.request(healthCtx, newRequest("health.ping", nil, nil, 0))
	stop()
	cl.close()
	if err != nil || !response.boolean("ok") {
		return false, nil
	}
	result, err := checkNativeClientUpdate(ctx, c, response.object("result"), updateCompatibleNative)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Automatic Browser Bridge native update failed:", err)
		return false, nil
	}
	if !result.boolean("updated") {
		return false, nil
	}
	// The authenticated local daemon must load the selected payload as well.
	running, err := stopLocalDaemon(ctx, c)
	if err != nil {
		return true, err
	}
	if running {
		if _, err := startLocalDaemon(ctx, c); err != nil {
			return true, err
		}
	}
	return forwardNativeUpdate(ctx, c, args)
}

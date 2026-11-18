// Generated from browser-bridge.ts. DO NOT EDIT.
function createBrowserBridge(call, defaults = {}) {
  if (typeof call !== "function") throw new TypeError("Supply the host browser_call callback");
  const keys = /* @__PURE__ */ new Set(["resultMode", "tabId", "destinationId", "budgetPreset", "extensionId", "targetBrowser", "targetProfile"]);
  function routingOptions(value, allowSignal = false) {
    const result = {};
    for (const key of Object.keys(value)) {
      if (allowSignal && key === "signal") continue;
      if (!keys.has(key)) throw new TypeError("Unknown browser_call option: " + key);
      const entry = value[key];
      if (entry !== void 0) result[key] = entry;
    }
    return result;
  }
  const base = routingOptions(defaults);
  async function invoke(method, params, options = {}) {
    options.signal?.throwIfAborted();
    const args = { ...base, ...routingOptions(options, true), method, params: params ?? {} };
    return call(args, options.signal ? { signal: options.signal } : void 0);
  }
  function bind(method) {
    return ((params, options) => invoke(method, params, options));
  }
  return Object.freeze({
    "access": Object.freeze({
      "request": bind("access.request"),
      "wait_for_change": bind("access.wait_for_change")
    }),
    "artifact": Object.freeze({
      "delete": bind("artifact.delete"),
      "read": bind("artifact.read")
    }),
    "cdp": Object.freeze({
      "dispatch_key_event": bind("cdp.dispatch_key_event"),
      "get_box_model": bind("cdp.get_box_model"),
      "get_computed_styles_for_node": bind("cdp.get_computed_styles_for_node"),
      "get_document": bind("cdp.get_document"),
      "get_dom_snapshot": bind("cdp.get_dom_snapshot")
    }),
    "daemon": Object.freeze({ "metrics": bind("daemon.metrics") }),
    "dom": Object.freeze({
      "baseline": Object.freeze({
        "compare": bind("dom.baseline.compare"),
        "create": bind("dom.baseline.create"),
        "describe": bind("dom.baseline.describe"),
        "release": bind("dom.baseline.release")
      }),
      "describe": bind("dom.describe"),
      "find_by_role": bind("dom.find_by_role"),
      "find_by_text": bind("dom.find_by_text"),
      "get_accessibility_tree": bind("dom.get_accessibility_tree"),
      "get_attributes": bind("dom.get_attributes"),
      "get_html": bind("dom.get_html"),
      "get_text": bind("dom.get_text"),
      "query": bind("dom.query"),
      "wait_for": bind("dom.wait_for")
    }),
    "download": Object.freeze({
      "cancel": bind("download.cancel"),
      "pause": bind("download.pause"),
      "release": bind("download.release"),
      "resource": bind("download.resource"),
      "resume": bind("download.resume"),
      "start": bind("download.start"),
      "status": bind("download.status")
    }),
    "emulation": Object.freeze({
      "apply": bind("emulation.apply"),
      "reset": bind("emulation.reset"),
      "status": bind("emulation.status")
    }),
    "files": Object.freeze({
      "release": bind("files.release"),
      "stage": bind("files.stage")
    }),
    "health": Object.freeze({ "ping": bind("health.ping") }),
    "input": Object.freeze({
      "click": bind("input.click"),
      "drag": bind("input.drag"),
      "fill": bind("input.fill"),
      "focus": bind("input.focus"),
      "hover": bind("input.hover"),
      "paste_image": bind("input.paste_image"),
      "perform": bind("input.perform"),
      "press_key": bind("input.press_key"),
      "scroll_into_view": bind("input.scroll_into_view"),
      "select_option": bind("input.select_option"),
      "set_checked": bind("input.set_checked"),
      "set_files": bind("input.set_files"),
      "touch": bind("input.touch"),
      "type": bind("input.type")
    }),
    "layout": Object.freeze({
      "get_box_model": bind("layout.get_box_model"),
      "hit_test": bind("layout.hit_test")
    }),
    "log": Object.freeze({ "tail": bind("log.tail") }),
    "navigation": Object.freeze({
      "go_back": bind("navigation.go_back"),
      "go_forward": bind("navigation.go_forward"),
      "navigate": bind("navigation.navigate"),
      "reload": bind("navigation.reload")
    }),
    "network": Object.freeze({
      "export_har": bind("network.export_har"),
      "intercept": Object.freeze({
        "add": bind("network.intercept.add"),
        "clear": bind("network.intercept.clear"),
        "list": bind("network.intercept.list"),
        "remove": bind("network.intercept.remove")
      })
    }),
    "page": Object.freeze({
      "evaluate": bind("page.evaluate"),
      "extract_content": bind("page.extract_content"),
      "get_console": bind("page.get_console"),
      "get_network": bind("page.get_network"),
      "get_state": bind("page.get_state"),
      "get_storage": bind("page.get_storage"),
      "get_text": bind("page.get_text"),
      "handle_dialog": bind("page.handle_dialog"),
      "wait_for_load_state": bind("page.wait_for_load_state")
    }),
    "patch": Object.freeze({
      "apply_dom": bind("patch.apply_dom"),
      "apply_styles": bind("patch.apply_styles"),
      "commit_session_baseline": bind("patch.commit_session_baseline"),
      "list": bind("patch.list"),
      "rollback": bind("patch.rollback")
    }),
    "performance": Object.freeze({ "get_metrics": bind("performance.get_metrics") }),
    "protocol": Object.freeze({
      "capabilities": bind("protocol.capabilities"),
      "describe": bind("protocol.describe")
    }),
    "screenshot": Object.freeze({
      "baseline": Object.freeze({
        "compare": bind("screenshot.baseline.compare"),
        "create": bind("screenshot.baseline.create"),
        "release": bind("screenshot.baseline.release")
      }),
      "capture_element": bind("screenshot.capture_element"),
      "capture_full_page": bind("screenshot.capture_full_page"),
      "capture_region": bind("screenshot.capture_region")
    }),
    "sensitive": Object.freeze({ "read": bind("sensitive.read") }),
    "session": Object.freeze({
      "export": bind("session.export"),
      "journal_delete": bind("session.journal_delete"),
      "journal_read": bind("session.journal_read"),
      "read": bind("session.read"),
      "release": bind("session.release"),
      "start": bind("session.start"),
      "status": bind("session.status"),
      "stop": bind("session.stop")
    }),
    "setup": Object.freeze({
      "get_status": bind("setup.get_status"),
      "install": bind("setup.install")
    }),
    "skill": Object.freeze({ "get_runtime_context": bind("skill.get_runtime_context") }),
    "styles": Object.freeze({
      "get_computed": bind("styles.get_computed"),
      "get_matched_rules": bind("styles.get_matched_rules")
    }),
    "tabs": Object.freeze({
      "activate": bind("tabs.activate"),
      "close": bind("tabs.close"),
      "create": bind("tabs.create"),
      "list": bind("tabs.list")
    }),
    "viewport": Object.freeze({
      "resize": bind("viewport.resize"),
      "scroll": bind("viewport.scroll")
    }),
    "webmcp": Object.freeze({
      "execute_tool": bind("webmcp.execute_tool"),
      "get_tool": bind("webmcp.get_tool"),
      "list_tools": bind("webmcp.list_tools")
    })
  });
}
export {
  createBrowserBridge
};

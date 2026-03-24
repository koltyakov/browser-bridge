// @ts-check

export {};

/**
 * @typedef {'cli' | 'mcp'} BridgeRequestSource
 */

/**
 * @typedef {'page.read' | 'page.evaluate' | 'dom.read' | 'styles.read' | 'layout.read' | 'viewport.control' | 'navigation.control' | 'screenshot.partial' | 'patch.dom' | 'patch.styles' | 'cdp.dom_snapshot' | 'cdp.box_model' | 'cdp.styles' | 'automation.input' | 'tabs.manage' | 'performance.read' | 'network.read'} Capability
 */

/**
 * @typedef {'ACCESS_DENIED' | 'SESSION_EXPIRED' | 'TAB_MISMATCH' | 'ORIGIN_MISMATCH' | 'CAPABILITY_MISSING' | 'ELEMENT_STALE' | 'RESULT_TRUNCATED' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'INVALID_REQUEST' | 'NATIVE_HOST_UNAVAILABLE' | 'EXTENSION_DISCONNECTED' | 'APPROVAL_PENDING' | 'TIMEOUT'} ErrorCode
 */

/**
 * @typedef {'tabs.list' | 'tabs.create' | 'tabs.close' | 'session.request_access' | 'session.get_status' | 'session.revoke' | 'skill.get_runtime_context' | 'setup.get_status' | 'setup.install' | 'page.get_state' | 'page.evaluate' | 'page.get_console' | 'page.wait_for_load_state' | 'page.get_storage' | 'page.get_text' | 'page.get_network' | 'navigation.navigate' | 'navigation.reload' | 'navigation.go_back' | 'navigation.go_forward' | 'dom.query' | 'dom.describe' | 'dom.get_text' | 'dom.get_attributes' | 'dom.wait_for' | 'dom.find_by_text' | 'dom.find_by_role' | 'dom.get_html' | 'dom.get_accessibility_tree' | 'layout.get_box_model' | 'layout.hit_test' | 'styles.get_computed' | 'styles.get_matched_rules' | 'viewport.scroll' | 'viewport.resize' | 'input.click' | 'input.focus' | 'input.type' | 'input.press_key' | 'input.set_checked' | 'input.select_option' | 'input.hover' | 'input.drag' | 'screenshot.capture_region' | 'screenshot.capture_element' | 'patch.apply_styles' | 'patch.apply_dom' | 'patch.list' | 'patch.rollback' | 'patch.commit_session_baseline' | 'cdp.get_document' | 'cdp.get_dom_snapshot' | 'cdp.get_box_model' | 'cdp.get_computed_styles_for_node' | 'performance.get_metrics' | 'log.tail' | 'health.ping'} BridgeMethod
 */

/**
 * @typedef {{
 *   protocol_version?: string,
 *   token_budget?: number | null,
 *   source?: BridgeRequestSource,
 *   [key: string]: unknown
 * }} BridgeMeta
 */

/**
 * @typedef {{
 *   id: string,
 *   method: BridgeMethod,
 *   session_id: string | null,
 *   params: Record<string, unknown>,
 *   meta: Required<Pick<BridgeMeta, 'protocol_version' | 'token_budget'>> & Record<string, unknown>
 * }} BridgeRequest
 */

/**
 * @typedef {{
 *   code: ErrorCode,
 *   message: string,
 *   details: unknown
 * }} BridgeFailure
 */

/**
 * @typedef {{
 *   id: string,
 *   ok: true,
 *   result: unknown,
 *   error: null,
 *   meta: { protocol_version: string } & Record<string, unknown>
 * }} BridgeSuccessResponse
 */

/**
 * @typedef {{
 *   id: string,
 *   ok: false,
 *   result: null,
 *   error: BridgeFailure,
 *   meta: { protocol_version: string } & Record<string, unknown>
 * }} BridgeFailureResponse
 */

/**
 * @typedef {BridgeSuccessResponse | BridgeFailureResponse} BridgeResponse
 */

/**
 * @typedef {{
 *   maxNodes?: number,
 *   maxDepth?: number,
 *   textBudget?: number,
 *   includeHtml?: boolean,
 *   includeScreenshot?: boolean,
 *   includeBbox?: boolean,
 *   attributeAllowlist?: string[],
 *   styleAllowlist?: string[]
 * }} BudgetOptions
 */

/**
 * @typedef {{
 *   maxNodes: number,
 *   maxDepth: number,
 *   textBudget: number,
 *   includeHtml: boolean,
 *   includeScreenshot: boolean,
 *   includeBbox: boolean,
 *   attributeAllowlist: string[],
 *   styleAllowlist: string[]
 * }} Budget
 */

/**
 * @typedef {{
 *   value: string,
 *   truncated: boolean,
 *   omitted: number
 * }} TruncateResult
 */

/**
 * @typedef {{
 *   tabId?: number,
 *   origin?: string,
 *   capabilities?: string[],
 *   ttlMs?: number,
 *   label?: string
 * }} AccessRequestParams
 */

/**
 * @typedef {{
 *   tabId: number,
 *   origin: string,
 *   capabilities: Capability[],
 *   ttlMs: number,
 *   label: string
 * }} NormalizedAccessRequest
 */

/**
 * @typedef {{
 *   selector?: string,
 *   withinRef?: string | null,
 *   maxNodes?: number,
 *   maxDepth?: number,
 *   textBudget?: number,
 *   includeHtml?: boolean,
 *   includeScreenshot?: boolean,
 *   attributeAllowlist?: string[],
 *   styleAllowlist?: string[],
 *   includeRoles?: boolean
 * }} DomQueryParams
 */

/**
 * @typedef {{
 *   selector: string,
 *   withinRef: string | null,
 *   budget: Budget,
 *   includeRoles: boolean
 * }} NormalizedDomQuery
 */

/**
 * @typedef {{
 *   elementRef?: string,
 *   properties?: string[]
 * }} StyleQueryParams
 */

/**
 * @typedef {{
 *   elementRef: string,
 *   properties: string[]
 * }} NormalizedStyleQuery
 */

/**
 * @typedef {{
 *   elementRef?: string,
 *   selector?: string
 * }} InputTarget
 */

/**
 * @typedef {{
 *   target?: InputTarget,
 *   button?: 'left' | 'middle' | 'right',
 *   clickCount?: number,
 *   text?: string,
 *   clear?: boolean,
 *   submit?: boolean,
 *   key?: string,
 *   modifiers?: string[]
 * }} InputActionParams
 */

/**
 * @typedef {{
 *   target: InputTarget,
 *   button: 'left' | 'middle' | 'right',
 *   clickCount: number,
 *   text: string,
 *   clear: boolean,
 *   submit: boolean,
 *   key: string,
 *   modifiers: string[]
 * }} NormalizedInputAction
 */

/**
 * @typedef {{
 *   target?: InputTarget,
 *   checked?: boolean
 * }} CheckedActionParams
 */

/**
 * @typedef {{
 *   target: InputTarget,
 *   checked: boolean
 * }} NormalizedCheckedAction
 */

/**
 * @typedef {{
 *   target?: InputTarget,
 *   values?: string[],
 *   labels?: string[],
 *   indexes?: number[]
 * }} SelectActionParams
 */

/**
 * @typedef {{
 *   target: InputTarget,
 *   values: string[],
 *   labels: string[],
 *   indexes: number[]
 * }} NormalizedSelectAction
 */

/**
 * @typedef {{
 *   target?: InputTarget,
 *   top?: number,
 *   left?: number,
 *   behavior?: 'auto' | 'smooth',
 *   relative?: boolean
 * }} ViewportActionParams
 */

/**
 * @typedef {{
 *   target: InputTarget,
 *   top: number,
 *   left: number,
 *   behavior: 'auto' | 'smooth',
 *   relative: boolean
 * }} NormalizedViewportAction
 */

/**
 * @typedef {{
 *   url?: string,
 *   waitForLoad?: boolean,
 *   timeoutMs?: number
 * }} NavigationActionParams
 */

/**
 * @typedef {{
 *   url: string,
 *   waitForLoad: boolean,
 *   timeoutMs: number
 * }} NormalizedNavigationAction
 */

/**
 * @typedef {{
 *   patchId?: string | null,
 *   target?: Record<string, unknown>,
 *   operation?: string | null,
 *   name?: string | null,
 *   declarations?: Record<string, string>,
 *   value?: unknown,
 *   important?: boolean
 * }} PatchOperationParams
 */

/**
 * @typedef {{
 *   patchId: string | null,
 *   target: Record<string, unknown>,
 *   operation: string | null,
 *   name: string | null,
 *   declarations: Record<string, string>,
 *   value: unknown,
 *   important: boolean
 * }} NormalizedPatchOperation
 */

/**
 * @typedef {{
 *   sessionId: string,
 *   tabId: number,
 *   origin: string,
 *   capabilities: Capability[],
 *   expiresAt: number
 * }} SessionState
 */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   detected: boolean,
 *   configPath: string,
 *   configExists: boolean,
 *   configured: boolean
 * }} McpClientStatus
 */

/**
 * @typedef {{
 *   name: string,
 *   path: string,
 *   exists: boolean,
 *   managed: boolean,
 *   version: string | null
 * }} SkillInstallationStatus
 */

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   detected: boolean,
 *   basePath: string,
 *   installed: boolean,
 *   managed: boolean,
 *   installedVersion: string | null,
 *   currentVersion: string | null,
 *   updateAvailable: boolean,
 *   skills: SkillInstallationStatus[]
 * }} SkillTargetStatus
 */

/**
 * @typedef {{
 *   scope: 'global' | 'local',
 *   mcpClients: McpClientStatus[],
 *   skillTargets: SkillTargetStatus[]
 * }} SetupStatus
 */

/**
 * @typedef {{
 *   action?: 'install' | 'uninstall',
 *   kind?: 'mcp' | 'skill',
 *   target?: string
 * }} SetupInstallParams
 */

/**
 * @typedef {{
 *   action: 'install' | 'uninstall',
 *   kind: 'mcp' | 'skill',
 *   target: string,
 *   paths: string[]
 * }} SetupInstallResult
 */

/**
 * @typedef {{
 *   expression?: string,
 *   awaitPromise?: boolean,
 *   timeoutMs?: number,
 *   returnByValue?: boolean
 * }} EvaluateParams
 */

/**
 * @typedef {{
 *   expression: string,
 *   awaitPromise: boolean,
 *   timeoutMs: number,
 *   returnByValue: boolean
 * }} NormalizedEvaluateParams
 */

/**
 * @typedef {{
 *   level?: string,
 *   clear?: boolean,
 *   limit?: number
 * }} ConsoleParams
 */

/**
 * @typedef {{
 *   level: string,
 *   clear: boolean,
 *   limit: number
 * }} NormalizedConsoleParams
 */

/**
 * @typedef {{
 *   selector?: string,
 *   text?: string,
 *   state?: 'attached' | 'detached' | 'visible' | 'hidden',
 *   timeoutMs?: number
 * }} WaitForParams
 */

/**
 * @typedef {{
 *   selector: string,
 *   text: string | null,
 *   state: 'attached' | 'detached' | 'visible' | 'hidden',
 *   timeoutMs: number
 * }} NormalizedWaitForParams
 */

/**
 * @typedef {{
 *   text?: string,
 *   exact?: boolean,
 *   selector?: string,
 *   maxResults?: number
 * }} FindByTextParams
 */

/**
 * @typedef {{
 *   text: string,
 *   exact: boolean,
 *   selector: string,
 *   maxResults: number
 * }} NormalizedFindByTextParams
 */

/**
 * @typedef {{
 *   role?: string,
 *   name?: string,
 *   selector?: string,
 *   maxResults?: number
 * }} FindByRoleParams
 */

/**
 * @typedef {{
 *   role: string,
 *   name: string,
 *   selector: string,
 *   maxResults: number
 * }} NormalizedFindByRoleParams
 */

/**
 * @typedef {{
 *   elementRef?: string,
 *   outer?: boolean,
 *   maxLength?: number
 * }} GetHtmlParams
 */

/**
 * @typedef {{
 *   elementRef: string,
 *   outer: boolean,
 *   maxLength: number
 * }} NormalizedGetHtmlParams
 */

/**
 * @typedef {{
 *   target?: InputTarget,
 *   duration?: number
 * }} HoverParams
 */

/**
 * @typedef {{
 *   target: InputTarget,
 *   duration: number
 * }} NormalizedHoverParams
 */

/**
 * @typedef {{
 *   source?: InputTarget,
 *   destination?: InputTarget,
 *   offsetX?: number,
 *   offsetY?: number
 * }} DragParams
 */

/**
 * @typedef {{
 *   source: InputTarget,
 *   destination: InputTarget,
 *   offsetX: number,
 *   offsetY: number
 * }} NormalizedDragParams
 */

/**
 * @typedef {{
 *   type?: 'local' | 'session',
 *   keys?: string[]
 * }} StorageParams
 */

/**
 * @typedef {{
 *   type: 'local' | 'session',
 *   keys: string[] | null
 * }} NormalizedStorageParams
 */

/**
 * @typedef {{
 *   waitForLoad?: boolean,
 *   timeoutMs?: number
 * }} WaitForLoadStateParams
 */

/**
 * @typedef {{
 *   waitForLoad: boolean,
 *   timeoutMs: number
 * }} NormalizedWaitForLoadStateParams
 */

/**
 * @typedef {{
 *   url?: string,
 *   active?: boolean
 * }} TabCreateParams
 */

/**
 * @typedef {{
 *   url: string,
 *   active: boolean
 * }} NormalizedTabCreateParams
 */

/**
 * @typedef {{
 *   tabId?: number
 * }} TabCloseParams
 */

/**
 * @typedef {{
 *   tabId: number
 * }} NormalizedTabCloseParams
 */

/**
 * @typedef {{
 *   maxDepth?: number,
 *   maxNodes?: number
 * }} AccessibilityTreeParams
 */

/**
 * @typedef {{
 *   maxDepth: number,
 *   maxNodes: number
 * }} NormalizedAccessibilityTreeParams
 */

/**
 * @typedef {{
 *   clear?: boolean,
 *   limit?: number,
 *   urlPattern?: string
 * }} NetworkParams
 */

/**
 * @typedef {{
 *   clear: boolean,
 *   limit: number,
 *   urlPattern: string | null
 * }} NormalizedNetworkParams
 */

/**
 * @typedef {{
 *   textBudget?: number
 * }} PageTextParams
 */

/**
 * @typedef {{
 *   textBudget: number
 * }} NormalizedPageTextParams
 */

/**
 * @typedef {{
 *   width?: number,
 *   height?: number,
 *   deviceScaleFactor?: number,
 *   reset?: boolean
 * }} ViewportResizeParams
 */

/**
 * @typedef {{
 *   width: number,
 *   height: number,
 *   deviceScaleFactor: number,
 *   reset: boolean
 * }} NormalizedViewportResizeParams
 */

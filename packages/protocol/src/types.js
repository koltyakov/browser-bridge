// @ts-check

export {};

/**
 * @typedef {'page.read' | 'dom.read' | 'styles.read' | 'layout.read' | 'viewport.control' | 'navigation.control' | 'screenshot.partial' | 'patch.dom' | 'patch.styles' | 'cdp.dom_snapshot' | 'cdp.box_model' | 'cdp.styles' | 'automation.input'} Capability
 */

/**
 * @typedef {'ACCESS_DENIED' | 'SESSION_EXPIRED' | 'TAB_MISMATCH' | 'ORIGIN_MISMATCH' | 'CAPABILITY_MISSING' | 'ELEMENT_STALE' | 'RESULT_TRUNCATED' | 'RATE_LIMITED' | 'INTERNAL_ERROR' | 'INVALID_REQUEST' | 'NATIVE_HOST_UNAVAILABLE' | 'APPROVAL_PENDING'} ErrorCode
 */

/**
 * @typedef {'tabs.list' | 'session.request_access' | 'session.get_status' | 'session.revoke' | 'skill.get_runtime_context' | 'page.get_state' | 'navigation.navigate' | 'navigation.reload' | 'navigation.go_back' | 'navigation.go_forward' | 'dom.query' | 'dom.describe' | 'dom.get_text' | 'dom.get_attributes' | 'layout.get_box_model' | 'layout.hit_test' | 'styles.get_computed' | 'styles.get_matched_rules' | 'viewport.scroll' | 'input.click' | 'input.focus' | 'input.type' | 'input.press_key' | 'input.set_checked' | 'input.select_option' | 'screenshot.capture_region' | 'screenshot.capture_element' | 'patch.apply_styles' | 'patch.apply_dom' | 'patch.list' | 'patch.rollback' | 'patch.commit_session_baseline' | 'cdp.get_document' | 'cdp.get_dom_snapshot' | 'cdp.get_box_model' | 'cdp.get_computed_styles_for_node' | 'log.tail' | 'health.ping'} BridgeMethod
 */

/**
 * @typedef {{
 *   protocol_version?: string,
 *   token_budget?: number | null,
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

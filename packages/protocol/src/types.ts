export type BridgeRequestSource = 'cli' | 'mcp';

export type AccessIntent = 'inspect' | 'interact' | 'capture' | 'navigate' | 'debugger' | 'general';

export interface AccessRequestParams {
  intent?: AccessIntent;
}

export interface NormalizedAccessRequestParams extends BridgeParams {
  intent: AccessIntent;
}

export type Capability =
  | 'page.read'
  | 'page.evaluate'
  | 'dom.read'
  | 'styles.read'
  | 'layout.read'
  | 'viewport.control'
  | 'navigation.control'
  | 'screenshot.partial'
  | 'patch.dom'
  | 'patch.styles'
  | 'cdp.dom_snapshot'
  | 'cdp.box_model'
  | 'cdp.styles'
  | 'cdp.input'
  | 'automation.input'
  | 'tabs.manage'
  | 'performance.read'
  | 'network.read'
  | 'network.intercept';

export type ErrorCode =
  | 'ACCESS_DENIED'
  | 'TAB_MISMATCH'
  | 'ELEMENT_STALE'
  | 'ELEMENT_AMBIGUOUS'
  | 'ELEMENT_NOT_ACTIONABLE'
  | 'ELEMENT_OBSCURED'
  | 'ELEMENT_NOT_FOUND'
  | 'INPUT_UNSUPPORTED'
  | 'INPUT_INVALID_TARGET'
  | 'INPUT_FOCUS_CHANGED'
  | 'DIALOG_NOT_OPEN'
  | 'DIALOG_ACTION_CONFLICT'
  | 'RESULT_TRUNCATED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'INVALID_REQUEST'
  | 'NATIVE_HOST_UNAVAILABLE'
  | 'EXTENSION_DISCONNECTED'
  | 'TIMEOUT';

export type BridgeMethod =
  | 'access.request'
  | 'tabs.list'
  | 'tabs.create'
  | 'tabs.close'
  | 'tabs.activate'
  | 'skill.get_runtime_context'
  | 'setup.get_status'
  | 'setup.install'
  | 'page.get_state'
  | 'page.evaluate'
  | 'page.get_console'
  | 'page.handle_dialog'
  | 'page.wait_for_load_state'
  | 'page.get_storage'
  | 'page.get_text'
  | 'page.extract_content'
  | 'page.get_network'
  | 'network.intercept.add'
  | 'network.intercept.remove'
  | 'network.intercept.list'
  | 'network.intercept.clear'
  | 'navigation.navigate'
  | 'navigation.reload'
  | 'navigation.go_back'
  | 'navigation.go_forward'
  | 'dom.query'
  | 'dom.describe'
  | 'dom.get_text'
  | 'dom.get_attributes'
  | 'dom.wait_for'
  | 'dom.find_by_text'
  | 'dom.find_by_role'
  | 'dom.get_html'
  | 'dom.get_accessibility_tree'
  | 'layout.get_box_model'
  | 'layout.hit_test'
  | 'styles.get_computed'
  | 'styles.get_matched_rules'
  | 'viewport.scroll'
  | 'viewport.resize'
  | 'input.click'
  | 'input.focus'
  | 'input.type'
  | 'input.fill'
  | 'input.press_key'
  | 'input.set_checked'
  | 'input.select_option'
  | 'input.hover'
  | 'input.drag'
  | 'input.scroll_into_view'
  | 'screenshot.capture_region'
  | 'screenshot.capture_element'
  | 'screenshot.capture_full_page'
  | 'patch.apply_styles'
  | 'patch.apply_dom'
  | 'patch.list'
  | 'patch.rollback'
  | 'patch.commit_session_baseline'
  | 'cdp.get_document'
  | 'cdp.get_dom_snapshot'
  | 'cdp.get_box_model'
  | 'cdp.get_computed_styles_for_node'
  | 'cdp.dispatch_key_event'
  | 'performance.get_metrics'
  | 'log.tail'
  | 'health.ping'
  | 'daemon.metrics';

export type CostClass = 'cheap' | 'moderate' | 'heavy' | 'extreme';

export interface BridgeMeta {
  protocol_version?: string;
  token_budget?: number | null;
  transport_bytes?: number;
  transport_approx_tokens?: number;
  transport_cost_class?: CostClass;
  text_bytes?: number;
  text_approx_tokens?: number;
  text_cost_class?: CostClass;
  image_approx_tokens?: number;
  image_bytes?: number;
  source?: BridgeRequestSource;
  response_bytes?: number;
  approx_tokens?: number;
  cost_class?: CostClass;
  debugger_backed?: boolean;
  budget_applied?: boolean;
  budget_truncated?: boolean;
  continuation_hint?: string | null;
  [key: string]: unknown;
}

export interface BridgeParams {
  [key: string]: unknown;
}

export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  tab_id: number | null;
  params: BridgeParams;
  meta: Required<Pick<BridgeMeta, 'protocol_version' | 'token_budget'>> & Record<string, unknown>;
}

export interface BridgeRecovery {
  hint: string;
  retry?: boolean;
  retryAfterMs?: number;
  alternativeMethod?: string;
}

export interface BridgeFailure {
  code: ErrorCode;
  message: string;
  details: unknown;
  recovery?: BridgeRecovery;
}

export interface BridgeSuccessResponse {
  id: string;
  ok: true;
  result: unknown;
  error: null;
  meta: { protocol_version: string } & Record<string, unknown>;
}

export interface BridgeFailureResponse {
  id: string;
  ok: false;
  result: null;
  error: BridgeFailure;
  meta: { protocol_version: string } & Record<string, unknown>;
}

export type BridgeResponse = BridgeSuccessResponse | BridgeFailureResponse;

export interface BudgetOptions {
  maxNodes?: number;
  maxDepth?: number;
  textBudget?: number;
  includeBbox?: boolean;
  attributeAllowlist?: string[];
}

export interface Budget {
  maxNodes: number;
  maxDepth: number;
  textBudget: number;
  includeBbox: boolean;
  attributeAllowlist: string[];
}

export interface TruncateResult {
  value: string;
  truncated: boolean;
  omitted: number;
}

export interface DomQueryParams extends BudgetOptions {
  selector?: string;
  withinRef?: string | null;
  budget?: BudgetOptions;
}

export interface NormalizedDomQuery extends BridgeParams {
  selector: string;
  withinRef: string | null;
  budget: Budget;
}

export interface DomFindResult {
  found: boolean;
  nodes: Record<string, unknown>[];
  count: number;
  scanned: number;
  truncated: boolean;
  truncationReason: 'maxResults' | 'scanLimit' | null;
}

export interface StyleQueryParams {
  elementRef?: string;
  target?: InputTarget;
  properties?: string[];
}

export interface NormalizedStyleQuery extends BridgeParams {
  elementRef: string;
  target: InputTarget;
  properties: string[];
}

export interface InputTarget {
  elementRef?: string;
  selector?: string;
}

export type InputExecutionMode = 'dom' | 'cdp';

export interface InputResolutionMetadata {
  strategy: 'elementRef' | 'selector-first' | 'selector-ranked' | 'stale-recovery';
  candidateCount: number;
  evaluatedCount: number;
  scrolled: boolean;
  hitTest: 'target' | 'descendant' | 'none' | 'not-required';
  recovered: boolean;
  oldRef?: string;
  newRef?: string;
  matchedFields?: string[];
  confidenceBasis?: string;
}

export interface InputExecutionMetadata {
  requestedMode: InputExecutionMode;
  actualMode: InputExecutionMode;
  fallbackReason: null;
  debuggerUsed: boolean;
  targetCoordinates?: { x: number; y: number };
}

export interface InputActionParams {
  target?: InputTarget;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  text?: string;
  value?: string;
  mode?: 'auto' | 'setter' | 'keystrokes';
  clear?: boolean;
  submit?: boolean;
  key?: string;
  modifiers?: string[];
  executionMode?: InputExecutionMode;
  recoverStale?: boolean;
}

export interface NormalizedInputAction extends BridgeParams {
  target: InputTarget;
  button: 'left' | 'middle' | 'right';
  clickCount: number;
  text: string;
  value: string;
  mode: 'auto' | 'setter' | 'keystrokes';
  clear: boolean;
  submit: boolean;
  key: string;
  modifiers: string[];
  executionMode: InputExecutionMode;
  recoverStale: boolean;
}

export interface CdpDispatchKeyEventParams {
  key?: string;
  code?: string;
  modifiers?: string[] | number;
}

export interface CdpNodeIdParams {
  nodeId?: number;
}

export interface NormalizedCdpDispatchKeyEventParams extends BridgeParams {
  key: string;
  code: string;
  modifiers: string[] | number;
}

export interface NormalizedCdpNodeIdParams extends BridgeParams {
  nodeId: number;
}

export interface CheckedActionParams {
  target?: InputTarget;
  checked?: boolean;
  executionMode?: InputExecutionMode;
  recoverStale?: boolean;
}

export interface NormalizedCheckedAction extends BridgeParams {
  target: InputTarget;
  checked: boolean;
  executionMode: InputExecutionMode;
  recoverStale: boolean;
}

export interface SelectActionParams {
  target?: InputTarget;
  values?: string[];
  labels?: string[];
  indexes?: number[];
  executionMode?: InputExecutionMode;
  recoverStale?: boolean;
}

export interface NormalizedSelectAction extends BridgeParams {
  target: InputTarget;
  values: string[];
  labels: string[];
  indexes: number[];
  executionMode: InputExecutionMode;
  recoverStale: boolean;
}

export interface ViewportActionParams {
  target?: InputTarget;
  top?: number;
  left?: number;
  behavior?: 'auto' | 'smooth';
  relative?: boolean;
}

export interface NormalizedViewportAction extends BridgeParams {
  target: InputTarget;
  top: number;
  left: number;
  behavior: 'auto' | 'smooth';
  relative: boolean;
}

export interface NavigationActionParams {
  url?: string;
  waitForLoad?: boolean;
  timeoutMs?: number;
}

export interface NormalizedNavigationAction extends BridgeParams {
  url: string;
  waitForLoad: boolean;
  timeoutMs: number;
}

export interface PatchOperationParams {
  patchId?: string | null;
  target?: Record<string, unknown>;
  operation?: string | null;
  name?: string | null;
  declarations?: Record<string, string>;
  value?: unknown;
  important?: boolean;
  verify?: boolean;
}

export interface NormalizedPatchOperation extends BridgeParams {
  patchId: string | null;
  target: Record<string, unknown>;
  operation: string | null;
  name: string | null;
  declarations: Record<string, string>;
  value: unknown;
  important: boolean;
  verify: boolean;
}

export interface McpClientStatus {
  key: string;
  label: string;
  detected: boolean;
  configPath: string;
  configExists: boolean;
  configured: boolean;
}

export interface SkillInstallationStatus {
  name: string;
  path: string;
  exists: boolean;
  managed: boolean;
  version: string | null;
}

export interface SkillTargetStatus {
  key: string;
  label: string;
  detected: boolean;
  basePath: string;
  installed: boolean;
  managed: boolean;
  installedVersion: string | null;
  currentVersion: string | null;
  updateAvailable: boolean;
  skills: SkillInstallationStatus[];
}

export interface SetupStatus {
  scope: 'global' | 'local';
  mcpClients: McpClientStatus[];
  skillTargets: SkillTargetStatus[];
}

export interface SetupInstallParams {
  action?: 'install' | 'uninstall';
  kind?: 'mcp' | 'skill';
  target?: string;
}

export interface SetupInstallResult {
  action: 'install' | 'uninstall';
  kind: 'mcp' | 'skill';
  target: string;
  paths: string[];
}

export interface EvaluateParams {
  expression?: string;
  awaitPromise?: boolean;
  timeoutMs?: number;
  returnByValue?: boolean;
}

export interface NormalizedEvaluateParams extends BridgeParams {
  expression: string;
  awaitPromise: boolean;
  timeoutMs: number;
  returnByValue: true;
}

export interface ConsoleParams {
  level?: string;
  clear?: boolean;
  limit?: number;
}

export type DialogAction = 'inspect' | 'accept' | 'dismiss';

export interface HandleDialogParams {
  action?: DialogAction;
  promptText?: string;
  /** Optional stale-decision check performed immediately before CDP dispatch. */
  expectedDialogId?: string;
}

export interface NormalizedHandleDialogParams extends BridgeParams {
  action: DialogAction;
  promptText: string | null;
  expectedDialogId: string | null;
}

export interface NormalizedConsoleParams extends BridgeParams {
  level: string;
  clear: boolean;
  limit: number;
}

export interface WaitForParams {
  selector?: string;
  text?: string;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
}

export interface NormalizedWaitForParams extends BridgeParams {
  selector: string;
  text: string | null;
  state: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs: number;
}

export interface FindByTextParams {
  text?: string;
  exact?: boolean;
  selector?: string;
  maxResults?: number;
}

export interface NormalizedFindByTextParams extends BridgeParams {
  text: string;
  exact: boolean;
  selector: string;
  maxResults: number;
}

export interface FindByRoleParams {
  role?: string;
  name?: string;
  selector?: string;
  maxResults?: number;
}

export interface NormalizedFindByRoleParams extends BridgeParams {
  role: string;
  name: string;
  selector: string;
  maxResults: number;
}

export interface GetHtmlParams {
  elementRef?: string;
  target?: InputTarget;
  outer?: boolean;
  maxLength?: number;
}

export interface NormalizedGetHtmlParams extends BridgeParams {
  elementRef: string;
  target: InputTarget;
  outer: boolean;
  maxLength: number;
}

export interface HoverParams {
  target?: InputTarget;
  duration?: number;
  modifiers?: string[];
  executionMode?: InputExecutionMode;
  recoverStale?: boolean;
}

export interface NormalizedHoverParams extends BridgeParams {
  target: InputTarget;
  duration: number;
  modifiers: string[];
  executionMode: InputExecutionMode;
  recoverStale: boolean;
}

export interface DragParams {
  source?: InputTarget;
  destination?: InputTarget;
  offsetX?: number;
  offsetY?: number;
  executionMode?: InputExecutionMode;
  recoverStale?: boolean;
}

export interface NormalizedDragParams extends BridgeParams {
  source: InputTarget;
  destination: InputTarget;
  offsetX: number;
  offsetY: number;
  executionMode: InputExecutionMode;
  recoverStale: boolean;
}

export interface StorageParams {
  type?: 'local' | 'session';
  keys?: string[];
}

export interface NormalizedStorageParams extends BridgeParams {
  type: 'local' | 'session';
  keys: string[] | null;
}

export type ExtractContentFormat = 'text' | 'markdown';
export type ExtractContentConsistency = 'best_effort' | 'settled';
export type ExtractContentSource = 'readability' | 'semantic-root' | 'body';

export interface ExtractContentParams {
  format?: ExtractContentFormat;
  selector?: string;
  includeMetadata?: boolean;
  consistency?: ExtractContentConsistency;
  textBudget?: number;
  settleTimeoutMs?: number;
}

export interface NormalizedExtractContentParams extends BridgeParams {
  format: ExtractContentFormat;
  selector: string | null;
  includeMetadata: boolean;
  consistency: ExtractContentConsistency;
  textBudget: number;
  settleTimeoutMs: number;
}

export interface ExtractContentResult {
  format: ExtractContentFormat;
  content: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  source: ExtractContentSource;
  root?: { tag: string; selector?: string };
  length: number;
  truncated: boolean;
  omitted: number;
  settlement?: { requested: boolean; quietMs: number; timedOut: boolean };
}

export interface WaitForLoadStateParams {
  waitForLoad?: boolean;
  timeoutMs?: number;
  url?: string;
  urlMatch?: 'exact' | 'contains' | 'regex';
}

export interface NormalizedWaitForLoadStateParams extends BridgeParams {
  waitForLoad: boolean;
  timeoutMs: number;
  url: string | null;
  urlMatch: 'exact' | 'contains' | 'regex' | null;
}

export interface TabCreateParams {
  url?: string;
  active?: boolean;
}

export interface NormalizedTabCreateParams extends BridgeParams {
  url: string;
  active: boolean;
}

export interface TabCloseParams {
  tabId?: number;
}

export interface NormalizedTabCloseParams extends BridgeParams {
  tabId: number;
}

export interface AccessibilityTreeParams {
  maxDepth?: number;
  maxNodes?: number;
  compact?: boolean;
  interactiveOnly?: boolean;
}

export interface NormalizedAccessibilityTreeParams extends BridgeParams {
  maxDepth: number;
  maxNodes: number;
  compact: boolean;
  interactiveOnly: boolean;
}

export interface AccessibilityTreeNode {
  nodeId: string;
  role: string;
  name: string;
  description: string;
  value: string;
  focused: boolean;
  required: boolean;
  checked: 'true' | 'false' | 'mixed' | null;
  disabled: boolean;
  interactive: boolean;
  semanticInteractive: boolean;
  focusable: boolean;
  focusableAndEnabled: boolean;
  ignored: boolean;
  childIds: string[];
}

export interface AccessibilityTreeResult {
  nodes: AccessibilityTreeNode[];
  rootIds: string[];
  count: number;
  total: number;
  rawTotal: number;
  source: 'cdp-accessibility';
  compact: boolean;
  interactiveOnly: boolean;
  truncated: boolean;
  truncation: {
    reason: 'maxNodes' | 'maxDepth';
    reasons: Array<'maxNodes' | 'maxDepth'>;
    maxNodes: number;
    maxDepth: number;
    omitted: number;
    missingChildCount: number;
    partialTopology: true;
  };
  continuationHint: string;
}

export type NetworkSource = 'fetch-xhr' | 'cdp';
export type NetworkCaptureAction = 'read' | 'start' | 'clear' | 'stop';

export interface NetworkParams {
  clear?: boolean;
  limit?: number;
  urlPattern?: string;
  source?: NetworkSource;
  capture?: NetworkCaptureAction;
}

export interface NormalizedNetworkParams extends BridgeParams {
  clear: boolean;
  limit: number;
  urlPattern: string | null;
  source: NetworkSource;
  capture: NetworkCaptureAction;
}

export interface CdpNetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status: number;
  mimeType: string;
  protocol: string;
  fromCache: boolean;
  fromDiskCache: boolean;
  fromServiceWorker: boolean;
  fromPrefetchCache: boolean;
  redirect: {
    count: number;
    hops: Array<{ url: string; status: number }>;
    truncated: boolean;
  };
  failureReason: string;
  duration: number;
  timestamp: number;
}

export interface NetworkResult {
  entries: Array<CdpNetworkEntry | Record<string, unknown>>;
  count: number;
  total: number;
  filteredTotal: number;
  dropped: number;
  abandoned: number;
  source: NetworkSource;
  capture: NetworkCaptureAction | null;
  armed: boolean;
  armedDuringCapture: boolean;
  captureState: 'armed' | 'stop_failed' | 'stopped' | 'instrumented';
  ownershipHeld: boolean;
  startedAt: number | null;
  inflight: number;
  truncated: boolean;
  truncation: { reason: 'limit' | null; limit: number; omitted: number };
}

export type NetworkInterceptAction = 'fulfill' | 'continue' | 'block';

export interface NetworkInterceptAddParams {
  urlPattern?: string;
  action?: NetworkInterceptAction;
  statusCode?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface NormalizedNetworkInterceptAddParams extends BridgeParams {
  urlPattern: string;
  action: NetworkInterceptAction;
  statusCode?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface PageTextParams {
  textBudget?: number;
}

export interface NormalizedPageTextParams extends BridgeParams {
  textBudget: number;
}

export interface LogTailParams {
  limit?: number;
}

export interface NormalizedLogTailParams extends BridgeParams {
  limit: number;
}

export interface ViewportResizeParams {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  reset?: boolean;
}

export interface NormalizedViewportResizeParams extends BridgeParams {
  width: number;
  height: number;
  deviceScaleFactor: number;
  reset: boolean;
}

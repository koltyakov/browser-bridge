import type { BridgeTransport } from '../../native-host/src/config.js';
import type {
  BridgeMeta,
  BridgeMethod,
  BridgeRequestSource,
  BridgeResponse,
  ScreenshotResult,
  SetupStatus,
} from '../../protocol/src/types.js';
import type { restartBridgeDaemon } from '../../native-host/src/daemon-process.js';

export type {
  BridgeMeta,
  BridgeMethod,
  BridgeRequestSource,
  BridgeResponse,
  BridgeTransport,
  ScreenshotResult,
};

export type McpClientName =
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'copilot'
  | 'opencode'
  | 'antigravity'
  | 'windsurf'
  | 'agents';

export type SupportedTarget = McpClientName;

export type AutoUpdatePolicy = 'off' | 'compatible';

export interface BrowserBridgeConfig {
  autoUpdate: AutoUpdatePolicy;
  [key: string]: unknown;
}

export interface NpmUpdateResult {
  updated: boolean;
  reason:
    | 'updated'
    | 'invalid_extension_version'
    | 'invalid_installed_version'
    | 'extension_not_newer'
    | 'not_global_install'
    | 'no_compatible_update';
  previousVersion?: string;
  version?: string;
}

export type Detector = () => boolean | Promise<boolean>;

export interface InstallAgentOptions {
  targets: SupportedTarget[];
  projectPath: string;
  global: boolean;
  [key: string]: unknown;
}

export interface SetupStatusOptions {
  global?: boolean;
  cwd?: string;
  projectPath?: string;
  mcpDetectors?: Record<string, Detector>;
  skillDetectors?: Record<string, Detector>;
  access?: (targetPath: string) => Promise<void>;
  readFile?: (targetPath: string, encoding: BufferEncoding) => Promise<string>;
}

export interface ProtocolHealthResult {
  extensionConnected?: boolean;
  extensionVersion?: string;
  daemonVersion?: string;
  supported_versions?: string[];
  extension_supported_versions?: string[];
  daemon_supported_versions?: string[];
  deprecated_since?: string;
  migration_hint?: string;
}

export type ClientMessage =
  | {
      type: 'registered';
      role: 'agent' | 'extension';
      clientId?: string;
    }
  | {
      type: 'registration_failed';
      error?: {
        code?: string;
        message?: string;
      };
    }
  | {
      type: 'agent.response';
      response: BridgeResponse;
    };

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export interface BridgeClientOptions {
  transport?: BridgeTransport;
  socketPath?: string;
  clientId?: string;
  defaultTimeoutMs?: number;
  autoReconnect?: boolean;
  checkProtocolOnConnect?: boolean;
  restartDaemonOnVersionMismatch?: boolean;
  restartDaemonFn?: typeof restartBridgeDaemon;
  updateNpmOnCompatibleVersion?: boolean;
  exitProcessOnNpmUpdate?: boolean;
  updateCompatibleNpmPackageFn?: (options: {
    extensionVersion: string;
    supportedVersions: readonly string[];
  }) => Promise<NpmUpdateResult>;
  authToken?: string | null;
}

export interface ShortcutCommand {
  method: BridgeMethod;
  resolve?: boolean;
  printMethod?: string;
  usage: string;
  description: string;
  build: (r: string[], ref?: string) => Record<string, unknown>;
}

export interface BrowserManifestStatus {
  browser: string;
  manifestPath: string;
  installed: boolean;
}

export interface DaemonRestartSummary {
  startsInWindow: number;
  windowMs: number;
  restartLoop: boolean;
}

export interface NativeHostManifestIssue {
  browser: string;
  manifestPath: string;
  message: string;
}

export interface DoctorTransportDiagnostics {
  kind: 'socket' | 'tcp' | 'unknown';
  local: true;
  status: 'reachable' | 'offline' | 'authentication_failed';
  proxyConfigured: boolean;
  proxyExposed: boolean | null;
  credentials: 'not_required' | 'accepted' | 'rejected' | 'unknown';
}

export interface DoctorConnectionDiagnostics {
  extensionCount: number;
  profileCount: number;
}

export interface DoctorProtocolDiagnostics {
  clientVersion: string;
  daemonVersion: string | null;
  daemonSupportedVersions: string[];
  extensionSupportedVersions: string[];
  daemonCompatible: boolean | null;
  extensionCompatible: boolean | null;
  compatible: boolean | null;
  migration: 'none' | 'update_client' | 'restart_daemon' | 'update_extension' | 'unknown';
}

export interface DoctorDebuggerDiagnostics {
  state: 'idle' | 'active' | 'conflict' | 'detached' | 'unknown';
  attachedTabCount: number | null;
  heldTabCount: number | null;
  pendingTabCount: number | null;
  recentReason:
    | 'debugger_conflict'
    | 'debugger_detached'
    | 'debugger_replaced'
    | 'debugger_canceled'
    | 'target_closed'
    | null;
  captureState:
    | 'idle'
    | 'stopped'
    | 'armed'
    | 'active'
    | 'capturing'
    | 'stop_failed'
    | 'unavailable'
    | 'unknown';
  captureActiveTabCount: number | null;
  captureOwnershipCount: number | null;
  captureInflightCount: number | null;
  interceptionActiveTabCount: number | null;
  interceptionRuleCount: number | null;
}

export interface DoctorDaemonMetrics {
  uptimeMs: number;
  activeAgents: number;
  activeExtensions: number;
  pendingRequests: number;
  requestsProcessed: number;
  requestsFailed: number;
  avgResponseTimeMs: number;
}

export interface DoctorRecentEvent {
  at?: string;
  method?: BridgeMethod;
  ok?: boolean;
  source?: BridgeRequestSource;
  cause?:
    | 'debugger_conflict'
    | 'debugger_detached'
    | 'debugger_replaced'
    | 'debugger_canceled'
    | 'target_closed'
    | 'dialog_conflict'
    | 'extension_disconnected'
    | 'wrong_window';
}

export interface DoctorSetupSummary {
  source: 'daemon' | 'direct';
  scope: 'global' | 'local';
  mcp: {
    detected: number;
    configured: number;
  };
  skills: {
    detected: number;
    installed: number;
    managed: number;
    updatesAvailable: number;
  };
}

export interface DoctorRemoteDiagnostics {
  configuredCount: number;
  status: 'not_configured' | 'not_probed_local_only' | 'config_unavailable';
  credentials: 'not_configured' | 'unverified';
}

export interface DoctorReport {
  manifestInstalled: boolean;
  manifestPath: string;
  allowedOrigins: string[];
  defaultExtensionId: string | null;
  defaultExtensionIdSource: string;
  daemonReachable: boolean;
  healthAvailable: boolean;
  extensionConnected: boolean;
  accessEnabled: boolean;
  enabledWindowId: number | null;
  routeTabId: number | null;
  routeReady: boolean;
  routeReason: string;
  daemonRestarts: DaemonRestartSummary;
  daemonLogPath: string;
  unwritableBridgePaths: string[];
  nativeHostManifestIssues: NativeHostManifestIssue[];
  issues: string[];
  nextSteps: string[];
  browserManifests: BrowserManifestStatus[];
  transport: DoctorTransportDiagnostics;
  connections: DoctorConnectionDiagnostics;
  protocol: DoctorProtocolDiagnostics;
  debugger: DoctorDebuggerDiagnostics;
  metrics: DoctorDaemonMetrics | null;
  recentEvents: DoctorRecentEvent[];
  recentCauses: DoctorRecentEvent['cause'][];
  setup: DoctorSetupSummary | null;
  remoteDestinations: DoctorRemoteDiagnostics;
  diagnosticFailures: string[];
}

export interface DoctorReportOptions {
  loadManifest?: () => Promise<{ allowed_origins?: string[] } | null>;
  checkBrowserManifests?: () => Promise<BrowserManifestStatus[]>;
  manifestPath?: string;
  defaultExtensionIdInfo?: { extensionId: string | null; source: string };
  bridgeClientRunner?: <T>(
    callback: (client: { request: BridgeClientRequest }) => Promise<T>
  ) => Promise<T>;
  readDaemonStartHistory?: () => Promise<number[]>;
  checkUnwritableBridgePaths?: () => Promise<string[]>;
  checkNativeHostManifestHealth?: (
    browserManifests: BrowserManifestStatus[]
  ) => Promise<NativeHostManifestIssue[]>;
  readInstalledExtensionIds?: (browserManifests: BrowserManifestStatus[]) => Promise<string[]>;
  collectSetupStatus?: () => Promise<SetupStatus>;
  readRemoteConfig?: () => Promise<{
    remotes: Array<{ id: string; host: string; port: number; token: string }>;
  }>;
  getLocalTransport?: () => BridgeTransport;
  readProxyConfig?: () => { enabled: boolean } | null;
  includeSetupStatus?: boolean;
}

export type BridgeClientRequest = (options: {
  method: BridgeMethod;
  tabId?: number | null;
  params?: Record<string, unknown>;
  meta?: BridgeMeta;
  timeoutMs?: number;
}) => Promise<BridgeResponse>;

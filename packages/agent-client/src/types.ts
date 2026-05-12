import type { BridgeTransport } from '../../native-host/src/config.js';
import type {
  BridgeMeta,
  BridgeMethod,
  BridgeRequestSource,
  BridgeResponse,
} from '../../protocol/src/types.js';
import type { restartBridgeDaemon } from '../../native-host/src/daemon-process.js';

export type { BridgeMeta, BridgeMethod, BridgeRequestSource, BridgeResponse, BridgeTransport };

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
  supported_versions?: string[];
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
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

export interface BridgeClientOptions {
  transport?: BridgeTransport;
  socketPath?: string;
  clientId?: string;
  defaultTimeoutMs?: number;
  autoReconnect?: boolean;
  restartDaemonOnVersionMismatch?: boolean;
  restartDaemonFn?: typeof restartBridgeDaemon;
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

export interface DoctorReport {
  manifestInstalled: boolean;
  manifestPath: string;
  allowedOrigins: string[];
  defaultExtensionId: string | null;
  defaultExtensionIdSource: string;
  daemonReachable: boolean;
  extensionConnected: boolean;
  accessEnabled: boolean;
  enabledWindowId: number | null;
  routeTabId: number | null;
  routeReady: boolean;
  routeReason: string;
  issues: string[];
  nextSteps: string[];
  browserManifests: BrowserManifestStatus[];
}

export interface DoctorReportOptions {
  loadManifest?: () => Promise<{ allowed_origins?: string[] } | null>;
  manifestPath?: string;
  defaultExtensionIdInfo?: { extensionId: string | null; source: string };
  bridgeClientRunner?: <T>(
    callback: (client: { request: BridgeClientRequest }) => Promise<T>
  ) => Promise<T>;
}

export type BridgeClientRequest = (options: {
  method: BridgeMethod;
  tabId?: number | null;
  params?: Record<string, unknown>;
  meta?: BridgeMeta;
  timeoutMs?: number;
}) => Promise<BridgeResponse>;

export interface ScreenshotResult {
  image: string;
  rect: Record<string, unknown>;
}

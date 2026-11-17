export type Track = 'scripted' | 'agent';
export type Effect = {
  sequence: number;
  phase: 'attempt' | 'commit';
  operation: string;
  record: string;
  value: string;
  atMs: number;
};
export type ExpectedEffect = { operation: string; record: string; count: number; value?: string };
export type Task = {
  id: string;
  family: string;
  instruction: string;
  expected: readonly ExpectedEffect[];
  fault?:
    | 'mcp_disconnect'
    | 'mcp_before'
    | 'mcp_after_commit'
    | 'worker_retained'
    | 'worker_detached'
    | 'stale_unique'
    | 'stale_ambiguous';
  headed?: boolean;
  timeoutMs: number;
  settleMs: number;
};
export type Usage = { input: number; output: number; cachedInput?: number; imageInput?: number };
export type Measurement =
  | { kind: 'model'; usage: Usage | null }
  | { kind: 'tool'; responseBytes: number }
  | { kind: 'browser_request' };
export type Counts = {
  modelRequests: number;
  hostToolCalls: number;
  browserRequests: number | null;
  responseBytes: number;
  tokens: {
    input: number;
    output: number;
    cachedInput: number | null;
    imageInput: number | null;
  } | null;
};
export type Observation = {
  effects: readonly Effect[];
  goalAtMs: number | null;
  focusThefts: number | null;
  url: string | null;
  dialogOpened: number | null;
  dialogClosed: number | null;
};
export type Assessment = {
  valid: boolean;
  success: boolean;
  safe: boolean | null;
  duplicateAttempts: number;
  duplicateCommits: number;
  unauthorizedAttempts: number;
  unauthorizedCommits: number;
  wrongValues: number;
  focusThefts: number | null;
  reasons: string[];
};
export type Identity = {
  name: string;
  version: string;
  track: Track;
  model?: string;
  instructionsHash?: string;
};
/** Only the trusted driver/controller receives these hooks. Never expose them
 * as agent tools or put effect counts, fixture source, or faults in the prompt. */
export type EpisodeContext = {
  task: Task;
  url: string;
  seed: number;
  output: string;
  signal: AbortSignal;
  measure: (event: Measurement) => void;
  waitForCommit: (operation: string, record: string) => Promise<void>;
  markFault: () => void;
  markRecovery: () => void;
  releaseReply: () => void;
};
export type DriverSession = {
  run: () => Promise<{ reported: 'completed' | 'stopped' | 'uncertain'; finalText?: string }>;
  observe: () => Promise<
    Pick<Observation, 'focusThefts' | 'url' | 'dialogOpened' | 'dialogClosed'>
  >;
  close: () => Promise<void>;
  provenance: Record<string, unknown>;
};
export type Driver = {
  identity: Identity;
  supportedTasks: readonly string[];
  browserRequestsObservable: boolean;
  open: (context: EpisodeContext) => Promise<DriverSession>;
};
export type EpisodeResult = {
  schemaVersion: 1;
  task: string;
  seed: number;
  driver: Identity;
  status: 'measured' | 'unsupported' | 'invalid';
  assessment: Assessment | null;
  counts: Counts | null;
  latencyMs: number | null;
  setupMs: number;
  auditMs: number;
  cleanupMs: number;
  cleanup: boolean;
  faultObserved: boolean;
  recoveryMs: number | null;
  timedOut: boolean;
  reported: string | null;
  observation: Observation | null;
  error: string | null;
  provenance: Record<string, unknown>;
};

export interface RecordingOptions {
  activity: boolean;
  network: boolean;
  bodies: boolean;
  messages: boolean;
  visual: boolean;
  durationMs: number;
  followTabs?: boolean;
  durable?: boolean;
  replay?: boolean;
}

export interface RecordingEvent extends Record<string, unknown> {
  seq: number;
  at: number;
  type: string;
}

export interface RecordingState {
  journal?: { journalId: string; append: (record: Record<string, unknown>) => Promise<void> };
  journalPending: Promise<void>;
  journalBytes: number;
  journalError: string | null;
  replayOwned: boolean;
  id: string;
  owner: string;
  tabId: number;
  options: RecordingOptions;
  active: boolean;
  networkOwned: boolean;
  stopping: Promise<void> | null;
  starting: Promise<void>;
  reason: string | null;
  epoch: string;
  startedAt: number;
  lastFrame: number;
  events: RecordingEvent[];
  bytes: number;
  bodyBytes: number;
  frameBytes: number;
  dropped: number;
  gaps: number;
  next: number;
  pending: Map<string, RecordingEvent>;
  bodies: Array<{
    requestId: string;
    tabId?: number;
    encoding: string;
    data: string;
    truncated: boolean;
  }>;
  frames: Array<{ at: number; data: string; width?: number; height?: number; tabId?: number }>;
  bodyTasks: Set<Promise<void>>;
  queue: Array<{ requestId: string; event: RecordingEvent; tabId: number }>;
  waiters: Set<() => void>;
  poll: Promise<void> | null;
  timer?: ReturnType<typeof setTimeout>;
  expiry?: ReturnType<typeof setTimeout>;
  assertAccess: () => Promise<void>;
  children: Map<number, { epoch: string; networkOwned: boolean }>;
}

export interface RecordingDependencies {
  page: (
    tabId: number,
    action: 'start' | 'drain' | 'status' | 'stop',
    sessionId: string,
    durationMs?: number
  ) => Promise<{
    epoch: string;
    active: boolean;
    events: Array<Record<string, unknown>>;
    dropped: number;
    missing?: boolean;
  }>;
  captureFrame: (tabId: number) => Promise<string>;
  startNetwork: (tabId: number) => Promise<unknown>;
  stopNetwork: (tabId: number) => Promise<unknown>;
  send: (tabId: number, method: string, params: Record<string, unknown>) => Promise<unknown>;
  childTabs?: (tabId: number) => Promise<Array<{ id: number; openerTabId?: number }>>;
  assertTab?: (tabId: number) => Promise<void>;
  acquireReplay?: (tabId: number) => Promise<void>;
  releaseReplay?: (tabId: number) => Promise<void>;
}

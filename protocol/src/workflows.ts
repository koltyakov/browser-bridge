import type { BridgeParams } from './types.js';

export interface EmulationConfig extends BridgeParams {
  device?: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    mobile: boolean;
    touch: boolean;
  };
  network?: { offline: boolean; latencyMs: number; downloadKbps: number; uploadKbps: number };
  cpuRate?: number;
  locale?: string;
  timezoneId?: string;
  geolocation?: { latitude: number; longitude: number; accuracy: number };
}

export interface CdpControllerDependencies {
  acquire: (tabId: number) => Promise<void>;
  release: (tabId: number) => Promise<void>;
  send: (tabId: number, method: string, params: Record<string, unknown>) => Promise<unknown>;
}

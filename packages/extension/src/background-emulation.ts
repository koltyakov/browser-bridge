import { normalizeEmulation } from '../../../protocol/src/emulation.js';

export type EmulationConfig = import('../../../protocol/src/workflows.js').EmulationConfig;
export type EmulationState = {
  config: EmulationConfig;
  resets: Map<string, { method: string; params: Record<string, unknown> }>;
  owned: boolean;
};

/** Own only overrides applied by this controller; never clear another debugger consumer's headers. */
export function createEmulationController(
  deps: import('../../../protocol/src/workflows.js').CdpControllerDependencies
) {
  const states: Map<number, EmulationState> = new Map();

  const queues: Map<number, Promise<unknown>> = new Map();

  function serial<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const work = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(tabId, work);
    void work
      .finally(() => {
        if (queues.get(tabId) === work) queues.delete(tabId);
      })
      .catch(() => {});
    return work;
  }

  function status(tabId: number) {
    const state = states.get(tabId);
    return {
      active: !!state?.owned,
      config: structuredClone(state?.config ?? {}),
      pendingReset: [...(state?.resets.keys() ?? [])],
    };
  }

  function apply(
    tabId: number,
    params: Record<string, unknown>,
    assertAccess: () => Promise<void> = async () => {}
  ) {
    const config = normalizeEmulation(params);
    return serial(tabId, async () => {
      await assertAccess();
      let state = states.get(tabId);
      if (!state) {
        state = { config: {}, resets: new Map(), owned: false };
        states.set(tabId, state);
        try {
          await deps.acquire(tabId);
          if (states.get(tabId) !== state)
            throw new Error('Debugger detached while acquiring emulation.');
          state.owned = true;
        } catch (error) {
          if (states.get(tabId) === state) states.delete(tabId);
          throw error;
        }
      }
      const current = state;
      /** Record reset BEFORE dispatch, since a failed transport can still have applied the override. */
      async function set(
        key: string,
        method: string,
        values: Record<string, unknown>,
        resetMethod: string,
        resetParams: Record<string, unknown>
      ) {
        await assertAccess();
        if (states.get(tabId) !== current) throw new Error('Debugger detached during emulation.');
        current.resets.set(key, { method: resetMethod, params: resetParams });
        await deps.send(tabId, method, values);
        if (states.get(tabId) !== current) throw new Error('Debugger detached during emulation.');
      }
      if (config.device) {
        const { touch, ...metrics } = config.device;
        await set(
          'device',
          'Emulation.setDeviceMetricsOverride',
          metrics,
          'Emulation.clearDeviceMetricsOverride',
          {}
        );
        await set(
          'touch',
          'Emulation.setTouchEmulationEnabled',
          { enabled: touch },
          'Emulation.setTouchEmulationEnabled',
          { enabled: false }
        );
        current.config.device = config.device;
      }
      if (config.network) {
        const n = config.network;
        await set(
          'network',
          'Network.emulateNetworkConditions',
          {
            offline: n.offline,
            latency: n.latencyMs,
            downloadThroughput: n.downloadKbps < 0 ? -1 : n.downloadKbps * 125,
            uploadThroughput: n.uploadKbps < 0 ? -1 : n.uploadKbps * 125,
          },
          'Network.emulateNetworkConditions',
          { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
        );
        current.config.network = n;
      }
      if (config.cpuRate !== undefined) {
        await set(
          'cpuRate',
          'Emulation.setCPUThrottlingRate',
          { rate: config.cpuRate },
          'Emulation.setCPUThrottlingRate',
          { rate: 1 }
        );
        current.config.cpuRate = config.cpuRate;
      }
      if (config.locale !== undefined) {
        await set(
          'locale',
          'Emulation.setLocaleOverride',
          { locale: config.locale },
          'Emulation.setLocaleOverride',
          {}
        );
        current.config.locale = config.locale;
      }
      if (config.timezoneId !== undefined) {
        await set(
          'timezoneId',
          'Emulation.setTimezoneOverride',
          { timezoneId: config.timezoneId },
          'Emulation.setTimezoneOverride',
          { timezoneId: '' }
        );
        current.config.timezoneId = config.timezoneId;
      }
      if (config.geolocation) {
        await set(
          'geolocation',
          'Emulation.setGeolocationOverride',
          config.geolocation,
          'Emulation.clearGeolocationOverride',
          {}
        );
        current.config.geolocation = config.geolocation;
      }
      return status(tabId);
    });
  }

  /** Reset every owned override even if one fails. Retain failures for a later retry. */
  function reset(tabId: number) {
    return serial(tabId, async () => {
      const state = states.get(tabId);
      if (!state) return { reset: true, ...status(tabId), failures: [] };

      const failures: Array<{ setting: string; message: string }> = [];
      for (const [key, command] of state.resets) {
        if (states.get(tabId) !== state) {
          failures.push({
            setting: 'debugger',
            message: 'Debugger detached during reset; stale cleanup was cancelled.',
          });
          break;
        }
        try {
          await deps.send(tabId, command.method, command.params);
          state.resets.delete(key);
          delete state.config[key];
        } catch (error) {
          failures.push({
            setting: key,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!state.resets.size && states.get(tabId) === state) {
        try {
          await deps.release(tabId);
          if (states.get(tabId) === state) states.delete(tabId);
        } catch (error) {
          failures.push({
            setting: 'debugger',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { reset: failures.length === 0, ...status(tabId), failures };
    });
  }

  function detached(tabId: number) {
    states.delete(tabId);
  }
  return { apply, reset, status, detached };
}

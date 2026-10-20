// @ts-check

import { normalizeEmulation } from '../../protocol/src/emulation.js';

/** @typedef {import('../../protocol/src/workflows.js').EmulationConfig} EmulationConfig */
/** @typedef {{ config: EmulationConfig, resets: Map<string, { method: string, params: Record<string, unknown> }>, owned: boolean }} EmulationState */

/** Own only overrides applied by this controller; never clear another debugger consumer's headers.
 * @param {import('../../protocol/src/workflows.js').CdpControllerDependencies} deps */
export function createEmulationController(deps) {
  /** @type {Map<number, EmulationState>} */
  const states = new Map();
  /** @type {Map<number, Promise<unknown>>} */
  const queues = new Map();

  /** @template T @param {number} tabId @param {() => Promise<T>} operation @returns {Promise<T>} */
  function serial(tabId, operation) {
    const work = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(tabId, work);
    void work
      .finally(() => {
        if (queues.get(tabId) === work) queues.delete(tabId);
      })
      .catch(() => {});
    return work;
  }

  /** @param {number} tabId */
  function status(tabId) {
    const state = states.get(tabId);
    return {
      active: !!state?.owned,
      config: structuredClone(state?.config ?? {}),
      pendingReset: [...(state?.resets.keys() ?? [])],
    };
  }

  /** @param {number} tabId @param {Record<string, unknown>} params */
  function apply(tabId, params) {
    const config = normalizeEmulation(params);
    return serial(tabId, async () => {
      let state = states.get(tabId);
      if (!state) {
        await deps.acquire(tabId);
        state = { config: {}, resets: new Map(), owned: true };
        states.set(tabId, state);
      }
      const current = state;
      /** Record reset BEFORE dispatch, since a failed transport can still have applied the override.
       * @param {string} key @param {string} method @param {Record<string, unknown>} values @param {string} resetMethod @param {Record<string, unknown>} resetParams */
      async function set(key, method, values, resetMethod, resetParams) {
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

  /** Reset every owned override even if one fails. Retain failures for a later retry.
   * @param {number} tabId */
  function reset(tabId) {
    return serial(tabId, async () => {
      const state = states.get(tabId);
      if (!state) return { reset: true, ...status(tabId), failures: [] };
      /** @type {Array<{ setting: string, message: string }>} */
      const failures = [];
      for (const [key, command] of state.resets) {
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
      if (!state.resets.size) {
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

  /** @param {number} tabId */
  function detached(tabId) {
    states.delete(tabId);
  }
  return { apply, reset, status, detached };
}

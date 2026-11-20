import { compareProtocolVersions } from './background-versioning.js';

const STORAGE_KEY = 'bbx-extension-update';
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const QUIET_MS = 1_000;
const GRANT_TIMEOUT_MS = 20_000;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

type UpdateChrome = {
  runtime: {
    getManifest: () => { version: string };
    requestUpdateCheck?: () => Promise<{ status: string; version?: string }>;
    reload: () => void;
  };
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
  management?: { getSelf: () => Promise<{ installType: string }> };
};

export function createExtensionUpdateController(
  chromeObj: UpdateChrome,
  deps: {
    enabled: boolean;
    send: (message: Record<string, unknown>) => boolean;
    isBusy: () => boolean;
    reportError: (error: unknown) => void;
    now?: () => number;
  }
): {
  handleMessage: (message: unknown) => boolean;
  beginRequest: () => () => void;
  disconnect: () => void;
} {
  const now = deps.now ?? Date.now;
  const current = chromeObj.runtime.getManifest().version;
  let lastCheckAt = 0;
  let pendingVersion: string | null = null;
  let active = 0;
  let checking = false;
  let coordinated = false;
  let waiting = false;
  let granted = false;
  let grantExpiresAt = 0;
  let reloading = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let grantTimer: ReturnType<typeof setTimeout> | null = null;
  const ready = deps.enabled
    ? chromeObj.storage.local
        .get(STORAGE_KEY)
        .then((stored) => {
          const value = stored[STORAGE_KEY];
          if (!value || typeof value !== 'object') return true;
          if (
            'lastCheckAt' in value &&
            typeof value.lastCheckAt === 'number' &&
            Number.isFinite(value.lastCheckAt)
          ) {
            lastCheckAt = value.lastCheckAt;
          }
          if (
            'pendingVersion' in value &&
            typeof value.pendingVersion === 'string' &&
            stableVersion.test(value.pendingVersion) &&
            compareProtocolVersions(value.pendingVersion, current) > 0
          ) {
            pendingVersion = value.pendingVersion;
          }
          return true;
        })
        .catch((error: unknown) => {
          deps.reportError(error);
          return false;
        })
    : Promise.resolve(false);

  function save(): Promise<void> {
    return chromeObj.storage.local.set({ [STORAGE_KEY]: { lastCheckAt, pendingVersion } });
  }
  function stopIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  }
  function cancelGrant(): void {
    if (grantTimer !== null) clearTimeout(grantTimer);
    grantTimer = null;
    if (waiting) deps.send({ type: 'host.update_cancel' });
    waiting = false;
    granted = false;
    grantExpiresAt = 0;
  }
  function scheduleIdle(): void {
    if (!coordinated || !pendingVersion || reloading || idleTimer !== null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // A delayed callback may run before the overdue timeout, after the
      // daemon has already resumed dispatching. Never reload on an old grant.
      if (waiting && now() >= grantExpiresAt) {
        cancelGrant();
        coordinated = false;
        return;
      }
      if (active > 0 || deps.isBusy()) {
        scheduleIdle();
        return;
      }
      if (granted) {
        reloading = true;
        if (grantTimer !== null) clearTimeout(grantTimer);
        grantTimer = null;
        try {
          chromeObj.runtime.reload();
        } catch (error) {
          reloading = false;
          coordinated = false;
          cancelGrant();
          deps.reportError(error);
        }
      } else if (!waiting) {
        const requestedAt = now();
        waiting = deps.send({ type: 'host.update_ready', version: pendingVersion });
        if (waiting) {
          grantExpiresAt = requestedAt + GRANT_TIMEOUT_MS;
          grantTimer = setTimeout(() => {
            cancelGrant();
            coordinated = false;
          }, GRANT_TIMEOUT_MS);
        }
      }
    }, QUIET_MS);
  }
  async function check(target: string): Promise<void> {
    if (!deps.enabled || !chromeObj.runtime.requestUpdateCheck || checking || reloading) return;
    checking = true;
    try {
      // An unreadable cooldown is not evidence that no recent check occurred.
      if (!(await ready)) return;
      if (pendingVersion) {
        scheduleIdle();
        return;
      }
      if (lastCheckAt > 0 && now() - lastCheckAt < CHECK_INTERVAL_MS) return;
      if (
        chromeObj.management?.getSelf &&
        (await chromeObj.management.getSelf()).installType === 'development'
      )
        return;
      lastCheckAt = now();
      // Persist before the API call so reconnects and worker restarts cannot
      // bypass the cooldown. A browser error is not permission to replay it.
      await save();
      const result = await chromeObj.runtime.requestUpdateCheck();
      if (
        result.status === 'update_available' &&
        result.version &&
        stableVersion.test(result.version) &&
        compareProtocolVersions(result.version, current) > 0 &&
        result.version.split('.')[0] === target.split('.')[0]
      ) {
        pendingVersion = result.version;
        await save();
        scheduleIdle();
      }
    } catch (error) {
      deps.reportError(error);
    } finally {
      checking = false;
    }
  }
  return {
    handleMessage(message) {
      if (!message || typeof message !== 'object' || !('type' in message)) return false;
      if (message.type !== 'host.update_check' && message.type !== 'host.update_apply')
        return false;
      if (
        !('version' in message) ||
        typeof message.version !== 'string' ||
        !stableVersion.test(message.version)
      )
        return true;
      if (message.type === 'host.update_check') {
        if (deps.enabled && compareProtocolVersions(message.version, current) > 0) {
          coordinated = true;
          void check(message.version);
        }
      } else if (waiting && message.version === pendingVersion) {
        granted = true;
        scheduleIdle();
      }
      return true;
    },
    beginRequest() {
      active++;
      stopIdleTimer();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        active--;
        scheduleIdle();
      };
    },
    disconnect() {
      stopIdleTimer();
      cancelGrant();
      coordinated = false;
    },
  };
}

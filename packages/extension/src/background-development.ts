export const DEVELOPMENT_BUILD_STAMP = 'development-build.json';
export const DEVELOPMENT_RELOAD_ALARM = 'development-build-check';

type DevelopmentReloadChrome = {
  runtime: { getURL: (path: string) => string; reload: () => void };
  management?: { getSelf: () => Promise<{ installType: string }> };
};

/** Compare against the digest loaded with this worker, not a previous poll. */
export function createDevelopmentReloadController(
  chromeObj: DevelopmentReloadChrome,
  options: {
    enabled: boolean;
    sourceDigest: string | null;
    fetch?: typeof fetch;
  }
): { checkForUpdate: () => Promise<void> } {
  let checking = false;
  let reloadRequested = false;

  async function checkForUpdate(): Promise<void> {
    if (!options.enabled || !options.sourceDigest || checking || reloadRequested) return;
    checking = true;
    try {
      // getSelf needs no management permission. Some Chromium variants omit it;
      // the generated build flag still excludes release builds in that case.
      if (chromeObj.management?.getSelf) {
        const self = await chromeObj.management.getSelf();
        if (self.installType !== 'development') return;
      }
      const response = await (options.fetch ?? fetch)(
        chromeObj.runtime.getURL(DEVELOPMENT_BUILD_STAMP),
        { cache: 'no-store' }
      );
      if (!response.ok) return;
      const stamp: unknown = await response.json();
      if (
        !stamp ||
        typeof stamp !== 'object' ||
        !('formatVersion' in stamp) ||
        stamp.formatVersion !== 1 ||
        !('complete' in stamp) ||
        stamp.complete !== true ||
        !('sourceDigest' in stamp) ||
        typeof stamp.sourceDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(stamp.sourceDigest) ||
        stamp.sourceDigest === options.sourceDigest
      ) {
        return;
      }
      // Ignore duplicate events until Chrome replaces this worker.
      reloadRequested = true;
      chromeObj.runtime.reload();
    } catch {
      // Staging removes the previous directory before publishing a complete
      // build. Missing files, partial JSON, and fetch errors are retried later.
    } finally {
      checking = false;
    }
  }

  return { checkForUpdate };
}

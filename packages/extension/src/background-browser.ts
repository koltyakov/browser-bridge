export function detectBrowserName(userAgent?: string): string {
  const normalizedUserAgent =
    typeof userAgent === 'string'
      ? userAgent
      : typeof globalThis.navigator?.userAgent === 'string'
        ? globalThis.navigator.userAgent
        : '';

  if (normalizedUserAgent.includes('Edg/')) return 'edge';
  if (normalizedUserAgent.includes('OPR/') || normalizedUserAgent.includes('Opera')) return 'opera';
  if (normalizedUserAgent.includes('Brave')) return 'brave';
  if (normalizedUserAgent.includes('Arc/')) return 'arc';
  if (normalizedUserAgent.includes('Vivaldi/')) return 'vivaldi';
  if (normalizedUserAgent.includes('Chrome/') || normalizedUserAgent.includes('Chromium/')) {
    return 'chrome';
  }
  return 'unknown';
}

type BrowserNavigator = {
  userAgent?: string;
  brave?: { isBrave?: () => Promise<boolean> };
};

/** Brave deliberately uses Chrome's UA. Its API is also exposed on WorkerNavigator. */
export async function getBrowserName(
  navigator: BrowserNavigator = globalThis.navigator
): Promise<string> {
  try {
    if ((await navigator?.brave?.isBrave?.()) === true) return 'brave';
  } catch {
    // A failed optional signal must not prevent the native identity handshake.
  }
  return detectBrowserName(navigator?.userAgent ?? '');
}

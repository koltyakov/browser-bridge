// @ts-check

/**
 * @param {string} [userAgent]
 * @returns {string}
 */
export function detectBrowserName(userAgent) {
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

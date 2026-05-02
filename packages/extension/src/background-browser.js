// @ts-check

/**
 * @param {string} [userAgent=navigator.userAgent]
 * @returns {string}
 */
export function detectBrowserName(userAgent = navigator.userAgent) {
  if (userAgent.includes('Edg/')) return 'edge';
  if (userAgent.includes('OPR/') || userAgent.includes('Opera')) return 'opera';
  if (userAgent.includes('Brave')) return 'brave';
  if (userAgent.includes('Arc/')) return 'arc';
  if (userAgent.includes('Vivaldi/')) return 'vivaldi';
  if (userAgent.includes('Chrome/') || userAgent.includes('Chromium/')) return 'chrome';
  return 'unknown';
}

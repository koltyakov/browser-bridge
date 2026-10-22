// @ts-check

/**
 * @param {unknown} value
 * @returns {import('./window-access.js').WindowActionCommand | null}
 */
export function parseWindowActionCommand(value) {
  if (!value || typeof value !== 'object') return null;
  const message = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof message.requestId !== 'string' ||
    !message.requestId ||
    message.requestId.length > 80 ||
    (message.action !== 'focus' && message.action !== 'disable') ||
    typeof message.windowId !== 'number' ||
    !Number.isSafeInteger(message.windowId) ||
    message.windowId <= 0 ||
    typeof message.enabledAt !== 'number' ||
    !Number.isFinite(message.enabledAt) ||
    message.enabledAt < 0
  )
    return null;
  return {
    requestId: message.requestId,
    action: message.action,
    windowId: message.windowId,
    enabledAt: message.enabledAt,
  };
}

/**
 * @param {unknown} value
 * @returns {import('./window-access.js').WindowActionRequest | null}
 */
export function parseWindowActionRequest(value) {
  const command = parseWindowActionCommand(value);
  if (!command) return null;
  const message = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof message.extensionId !== 'string' ||
    !message.extensionId ||
    message.extensionId.length > 80
  )
    return null;
  return { ...command, extensionId: message.extensionId };
}

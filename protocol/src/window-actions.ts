export function parseWindowActionCommand(
  value: unknown
): import('./window-access.js').WindowActionCommand | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
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

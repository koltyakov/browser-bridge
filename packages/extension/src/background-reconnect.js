// @ts-check

/**
 * @template TTimer
 * @typedef {{
 *   currentTimer: TTimer | null,
 *   currentDelay: number,
 *   maxDelay: number,
 *   onReconnect: () => void,
 *   clearTimeoutFn: (timer: TTimer) => void,
 *   setTimeoutFn: (callback: () => void, delay: number) => TTimer
 * }} ReconnectScheduleOptions
 */

/**
 * Schedule a reconnect attempt, replacing any previous timer and returning the
 * next backoff delay to use after this attempt is queued.
 *
 * @template TTimer
 * @param {ReconnectScheduleOptions<TTimer>} options
 * @returns {{ timer: TTimer, nextDelay: number }}
 */
export function scheduleReconnectAttempt({
  currentTimer,
  currentDelay,
  maxDelay,
  onReconnect,
  clearTimeoutFn,
  setTimeoutFn,
}) {
  if (currentTimer) {
    clearTimeoutFn(currentTimer);
  }

  return {
    timer: setTimeoutFn(onReconnect, currentDelay),
    nextDelay: Math.min(currentDelay * 2, maxDelay),
  };
}

/**
 * Record a native host disconnect and drop entries older than the window.
 * The returned array is a new pruned list including `now`, oldest first.
 *
 * @param {number[]} disconnectTimes
 * @param {number} now
 * @param {number} windowMs
 * @returns {number[]}
 */
export function recordNativeDisconnect(disconnectTimes, now, windowMs) {
  return [...disconnectTimes.filter((at) => at <= now && now - at <= windowMs), now];
}

/**
 * A connection is unstable when the native host disconnected at least
 * `threshold` times inside the recent window — the daemon (or host) is
 * starting and dying repeatedly rather than being merely offline.
 *
 * @param {number[]} disconnectTimes
 * @param {number} now
 * @param {number} windowMs
 * @param {number} threshold
 * @returns {boolean}
 */
export function isNativeConnectionUnstable(disconnectTimes, now, windowMs, threshold) {
  const recent = disconnectTimes.filter((at) => at <= now && now - at <= windowMs);
  return recent.length >= threshold;
}

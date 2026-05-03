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

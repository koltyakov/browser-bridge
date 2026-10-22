export type ReconnectScheduleOptions<TTimer> = {
  currentTimer: TTimer | null;
  currentDelay: number;
  maxDelay: number;
  onReconnect: () => void;
  clearTimeoutFn: (timer: TTimer) => void;
  setTimeoutFn: (callback: () => void, delay: number) => TTimer;
};
/** Schedule a reconnect attempt, replacing any previous timer and returning the
next backoff delay to use after this attempt is queued. */
export function scheduleReconnectAttempt<TTimer>({
  currentTimer,
  currentDelay,
  maxDelay,
  onReconnect,
  clearTimeoutFn,
  setTimeoutFn,
}: ReconnectScheduleOptions<TTimer>): { timer: TTimer; nextDelay: number } {
  if (currentTimer) {
    clearTimeoutFn(currentTimer);
  }

  return {
    timer: setTimeoutFn(onReconnect, currentDelay),
    nextDelay: Math.min(currentDelay * 2, maxDelay),
  };
}

/** Record a native host disconnect and drop entries older than the window.
The returned array is a new pruned list including `now`, oldest first. */
export function recordNativeDisconnect(
  disconnectTimes: number[],
  now: number,
  windowMs: number
): number[] {
  return [...disconnectTimes.filter((at) => at <= now && now - at <= windowMs), now];
}

/** A connection is unstable when the native host disconnected at least
`threshold` times inside the recent window - the daemon (or host) is
starting and dying repeatedly rather than being merely offline. */
export function isNativeConnectionUnstable(
  disconnectTimes: number[],
  now: number,
  windowMs: number,
  threshold: number
): boolean {
  const recent = disconnectTimes.filter((at) => at <= now && now - at <= windowMs);
  return recent.length >= threshold;
}

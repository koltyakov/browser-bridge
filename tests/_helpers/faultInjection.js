// @ts-check

import { EventEmitter } from 'node:events';

/**
 * @typedef {{
 *   socket: import('node:net').Socket & EventEmitter,
 *   writes: string[],
 *   emitDrain: () => void
 * }} StallingSocketHarness
 */

/**
 * @typedef {{
 *   stream: import('node:net').Socket & EventEmitter,
 *   writes: string[],
 *   error: Error,
 *   readonly bytesWritten: number
 * }} ErroringStreamHarness
 */

/**
 * @typedef {{
 *   id: ReturnType<typeof setTimeout>,
 *   callback: (() => void) | null,
 *   delay: number,
 *   cleared: boolean,
 *   ran: boolean
 * }} ScheduledTimer
 */

/**
 * @typedef {{
 *   setTimeout: MockSetTimeout,
 *   clearTimeout: MockClearTimeout,
 *   runNext: () => Promise<boolean>,
 *   runAll: () => Promise<void>,
 *   readonly delays: number[]
 * }} ClockController
 */

/**
 * @typedef {(callback: TimerHandler, delay?: number) => ReturnType<typeof setTimeout>} MockSetTimeout
 */

/**
 * @typedef {(timerId: string | number | ReturnType<typeof setTimeout> | undefined) => void} MockClearTimeout
 */

/**
 * @returns {StallingSocketHarness}
 */
export function fakeSocketThatStalls() {
  const socket = new EventEmitter();
  /** @type {string[]} */
  const writes = [];

  const typedSocket =
    /** @type {import('node:net').Socket & EventEmitter & { destroyed?: boolean }} */ (
      /** @type {unknown} */ (socket)
    );
  typedSocket.destroyed = false;
  typedSocket.setEncoding = () => typedSocket;
  typedSocket.end = (callback) => {
    if (typeof callback === 'function') {
      callback();
    }
    socket.emit('end');
    return typedSocket;
  };
  typedSocket.destroy = () => {
    typedSocket.destroyed = true;
    socket.emit('close');
    return typedSocket;
  };
  typedSocket.write = (chunk) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return false;
  };

  return {
    socket: typedSocket,
    writes,
    emitDrain() {
      socket.emit('drain');
    },
  };
}

/**
 * @param {number} maxBytes
 * @returns {ErroringStreamHarness}
 */
export function fakeStreamThatErrorsAfterNBytes(maxBytes) {
  const stream = new EventEmitter();
  /** @type {string[]} */
  const writes = [];
  let bytesWritten = 0;
  const error = new Error(`Fake stream exceeded ${maxBytes} bytes.`);

  const typedStream =
    /** @type {import('node:net').Socket & EventEmitter & { destroyed?: boolean }} */ (
      /** @type {unknown} */ (stream)
    );
  typedStream.destroyed = false;
  typedStream.setEncoding = () => typedStream;
  typedStream.end = (callback) => {
    if (typeof callback === 'function') {
      callback();
    }
    stream.emit('end');
    return typedStream;
  };
  typedStream.destroy = () => {
    typedStream.destroyed = true;
    stream.emit('close');
    return typedStream;
  };
  typedStream.write = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const nextBytes = bytesWritten + Buffer.byteLength(text);
    if (nextBytes > maxBytes) {
      throw error;
    }
    bytesWritten = nextBytes;
    writes.push(text);
    return true;
  };

  return {
    stream: typedStream,
    writes,
    error,
    get bytesWritten() {
      return bytesWritten;
    },
  };
}

/**
 * @returns {ClockController}
 */
export function clockController() {
  /** @type {ScheduledTimer[]} */
  const timers = [];
  let nextId = 0;

  const setTimeoutMock = /** @type {MockSetTimeout} */ (
    /** @param {TimerHandler} callback @param {number | undefined} [delay=0] */
    (callback, delay = 0) => {
      const timerId = /** @type {ReturnType<typeof setTimeout>} */ (
        /** @type {unknown} */ ({ id: (nextId += 1) })
      );
      const timer = {
        id: timerId,
        callback: typeof callback === 'function' ? () => callback() : null,
        delay: Number(delay),
        cleared: false,
        ran: false,
      };
      timers.push(timer);
      return timer.id;
    }
  );

  const clearTimeoutMock = /** @type {MockClearTimeout} */ (
    (timerId) => {
      const targetId = /** @type {ReturnType<typeof setTimeout>} */ (
        /** @type {unknown} */ (timerId)
      );
      const timer = timers.find((entry) => entry.id === targetId);
      if (timer) {
        timer.cleared = true;
      }
    }
  );

  /**
   * @returns {Promise<boolean>}
   */
  async function runNext() {
    const timer = timers.find((entry) => !entry.cleared && !entry.ran);
    if (!timer) {
      return false;
    }
    timer.ran = true;
    timer.callback?.();
    await Promise.resolve();
    await Promise.resolve();
    return true;
  }

  /**
   * @returns {Promise<void>}
   */
  async function runAll() {
    while (await runNext()) {
      // Keep draining scheduled timers until the queue is empty.
    }
  }

  return {
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    runNext,
    runAll,
    get delays() {
      return timers.map((timer) => timer.delay);
    },
  };
}

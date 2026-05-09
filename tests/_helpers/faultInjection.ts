import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

export type StallingSocketHarness = {
  socket: Socket & EventEmitter;
  writes: string[];
  emitDrain: () => void;
};

export type ErroringStreamHarness = {
  stream: Socket & EventEmitter;
  writes: string[];
  error: Error;
  readonly bytesWritten: number;
};

export type MockSetTimeout = (
  callback: TimerHandler,
  delay?: number
) => ReturnType<typeof setTimeout>;

export type MockClearTimeout = (
  timerId: string | number | ReturnType<typeof setTimeout> | undefined
) => void;

export type ScheduledTimer = {
  id: ReturnType<typeof setTimeout>;
  callback: (() => void) | null;
  delay: number;
  cleared: boolean;
  ran: boolean;
};

export type ClockController = {
  setTimeout: MockSetTimeout;
  clearTimeout: MockClearTimeout;
  runNext: () => Promise<boolean>;
  runAll: () => Promise<void>;
  readonly delays: number[];
};

type MutableFakeSocket = Socket & EventEmitter & { destroyed?: boolean };

export function fakeSocketThatStalls(): StallingSocketHarness {
  const socket = new EventEmitter();
  const writes: string[] = [];

  const typedSocket = socket as MutableFakeSocket;
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

export function fakeStreamThatErrorsAfterNBytes(maxBytes: number): ErroringStreamHarness {
  const stream = new EventEmitter();
  const writes: string[] = [];
  let bytesWritten = 0;
  const error = new Error(`Fake stream exceeded ${maxBytes} bytes.`);

  const typedStream = stream as MutableFakeSocket;
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

export function clockController(): ClockController {
  const timers: ScheduledTimer[] = [];
  let nextId = 0;

  const setTimeoutMock: MockSetTimeout = (callback, delay = 0) => {
    const timerId = { id: (nextId += 1) } as unknown as ReturnType<typeof setTimeout>;
    const timer: ScheduledTimer = {
      id: timerId,
      callback: typeof callback === 'function' ? () => callback() : null,
      delay: Number(delay),
      cleared: false,
      ran: false,
    };
    timers.push(timer);
    return timer.id;
  };

  const clearTimeoutMock: MockClearTimeout = (timerId) => {
    const targetId = timerId as ReturnType<typeof setTimeout>;
    const timer = timers.find((entry) => entry.id === targetId);
    if (timer) {
      timer.cleared = true;
    }
  };

  async function runNext(): Promise<boolean> {
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

  async function runAll(): Promise<void> {
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

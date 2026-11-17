import { tasks } from './tasks.ts';
import type { Driver, DriverSession, Identity, Measurement, Observation, Usage } from './types.ts';

/** A malformed adapter must invalidate an episode, not look like a tool failure. */
export class AdapterValidationError extends Error {
  constructor(field: string, message: string) {
    super(`Invalid adapter ${field}: ${message}`);
    this.name = 'AdapterValidationError';
  }
}

function invalid(field: string, message: string): never {
  throw new AdapterValidationError(field, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(field, 'expected an object');
  return value as Record<string, unknown>;
}

/** Wire-like data has own, enumerable values, not inherited fields or getters.
 * Driver/session methods may still live on a class prototype. */
function data(
  value: unknown,
  field: string,
  required?: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  const result = record(value, field);
  const prototype: unknown = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(field, 'expected a plain data object');
  for (const key of Reflect.ownKeys(result)) {
    if (typeof key !== 'string' || (required && ![...required, ...optional].includes(key)))
      invalid(field, 'unexpected field');
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      invalid(field, 'expected enumerable data fields');
  }
  for (const key of required ?? []) {
    if (!Object.hasOwn(result, key)) invalid(`${field}.${key}`, 'required field is missing');
  }
  return result;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length || value.trim() !== value)
    invalid(field, 'expected a nonblank trimmed string');
  return value;
}

export function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalid(field, 'expected a nonnegative safe integer');
  return value;
}

export function addCount(left: number, right: number, field: string): number {
  return count(left + right, field);
}

export function measurement(value: unknown): Measurement {
  const event = data(value, 'measurement');
  switch (event.kind) {
    case 'model': {
      data(event, 'measurement', ['kind', 'usage']);
      if (event.usage === null) return { kind: 'model', usage: null };
      const source = data(
        event.usage,
        'measurement.usage',
        ['input', 'output'],
        ['cachedInput', 'imageInput']
      );
      const usage: Usage = {
        input: count(source.input, 'measurement.usage.input'),
        output: count(source.output, 'measurement.usage.output'),
      };
      for (const key of ['cachedInput', 'imageInput'] as const) {
        if (!Object.hasOwn(source, key)) continue;
        const subset = count(source[key], `measurement.usage.${key}`);
        if (subset > usage.input)
          invalid(`measurement.usage.${key}`, 'input token subset exceeds input');
        usage[key] = subset;
      }
      return { kind: 'model', usage };
    }
    case 'tool':
      data(event, 'measurement', ['kind', 'responseBytes']);
      return {
        kind: 'tool',
        responseBytes: count(event.responseBytes, 'measurement.responseBytes'),
      };
    case 'browser_request':
      data(event, 'measurement', ['kind']);
      return { kind: 'browser_request' };
    default:
      return invalid('measurement.kind', 'expected model, tool, or browser_request');
  }
}

export function validateDriver(value: unknown): Driver {
  const driver = record(value, 'descriptor');
  const source = data(
    driver.identity,
    'identity',
    ['name', 'version', 'track'],
    ['model', 'instructionsHash']
  );
  const name = text(source.name, 'identity.name');
  if (!/^[a-z0-9-]{1,64}$/.test(name))
    invalid('identity.name', 'expected 1..64 lowercase letters, digits, or hyphens');
  const identity: Identity = {
    name,
    version: text(source.version, 'identity.version'),
    track:
      source.track === 'scripted' || source.track === 'agent'
        ? source.track
        : invalid('identity.track', 'expected scripted or agent'),
  };
  if (identity.track === 'agent' || Object.hasOwn(source, 'model'))
    identity.model = text(source.model, 'identity.model');
  if (identity.track === 'agent' || Object.hasOwn(source, 'instructionsHash')) {
    const hash = text(source.instructionsHash, 'identity.instructionsHash');
    if (!/^[a-f0-9]{64}$/i.test(hash))
      invalid('identity.instructionsHash', 'expected a SHA-256 hex digest');
    identity.instructionsHash = hash;
  }
  if (typeof driver.browserRequestsObservable !== 'boolean')
    invalid('browserRequestsObservable', 'expected a boolean');
  if (!Array.isArray(driver.supportedTasks))
    invalid('supportedTasks', 'expected an array of task IDs');
  const known = new Set(tasks.map((task) => task.id));
  const selected: string[] = [];
  for (const id of driver.supportedTasks as unknown[]) {
    if (typeof id !== 'string' || !known.has(id))
      invalid('supportedTasks', 'unknown or malformed task ID');
    if (selected.includes(id)) invalid('supportedTasks', 'duplicate task ID');
    selected.push(id);
  }
  const open = driver.open;
  if (typeof open !== 'function') invalid('open', 'expected a function');
  // Snapshot declarations so later mutation cannot rewrite already-validated
  // labels or coverage. Bind open() to retain legitimate class-based adapters.
  return {
    identity: Object.freeze(identity),
    supportedTasks: Object.freeze(selected),
    browserRequestsObservable: driver.browserRequestsObservable,
    open: (open as Driver['open']).bind(driver),
  };
}

function json(value: unknown, field: string, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') invalid(field, 'expected JSON-compatible data');
  if (ancestors.has(value) || depth > 32) invalid(field, 'cyclic or excessively nested data');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length)
        invalid(field, 'expected a dense JSON array');
      const entries: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor))
          invalid(field, 'expected JSON array data values');
        entries.push(json(descriptor.value, field, ancestors, depth + 1));
      }
      return entries;
    }
    const source = data(value, field);
    return Object.fromEntries(
      Object.entries(source).map(([key, entry]) => [key, json(entry, field, ancestors, depth + 1)])
    );
  } finally {
    ancestors.delete(value);
  }
}

/** Cleanup remains callable even if another part of the returned session is
 * malformed. Never call a missing/non-function close or trust a false result. */
export function sessionClose(value: unknown): (() => Promise<void>) | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const close: unknown = (value as Record<string, unknown>).close;
  if (typeof close !== 'function') return null;
  return async () => {
    const result: unknown = await Reflect.apply(close, value, []);
    if (result !== undefined) invalid('session.close', 'must resolve to undefined');
  };
}

export type SessionBoundary = {
  run: () => Promise<unknown>;
  observe: () => Promise<unknown>;
  provenance: Record<string, unknown>;
};

export function validateSession(value: unknown): SessionBoundary {
  const session = record(value, 'session');
  const run = session.run;
  const observe = session.observe;
  if (typeof run !== 'function') invalid('session.run', 'expected a function');
  if (typeof observe !== 'function') invalid('session.observe', 'expected a function');
  if (typeof session.close !== 'function') invalid('session.close', 'expected a function');
  const provenance = record(
    json(data(session.provenance, 'session.provenance'), 'session.provenance'),
    'session.provenance'
  );
  return {
    run: async () => Reflect.apply(run, session, []) as unknown,
    observe: async () => Reflect.apply(observe, session, []) as unknown,
    provenance,
  };
}

export function runResult(
  value: unknown,
  agent: boolean
): Awaited<ReturnType<DriverSession['run']>> {
  const result = data(value, 'run result', ['reported'], ['finalText']);
  if (
    result.reported !== 'completed' &&
    result.reported !== 'stopped' &&
    result.reported !== 'uncertain'
  )
    invalid('run result.reported', 'expected completed, stopped, or uncertain');
  if (agent || Object.hasOwn(result, 'finalText')) {
    if (typeof result.finalText !== 'string' || !result.finalText.trim())
      invalid('run result.finalText', 'expected the nonblank actual final response');
    return { reported: result.reported, finalText: result.finalText };
  }
  return { reported: result.reported };
}

export function observation(
  value: unknown
): Pick<Observation, 'focusThefts' | 'url' | 'dialogOpened' | 'dialogClosed'> {
  const source = data(value, 'observation', ['focusThefts', 'url', 'dialogOpened', 'dialogClosed']);
  let url: string | null = null;
  if (source.url !== null) {
    url = text(source.url, 'observation.url');
    try {
      new URL(url);
    } catch {
      invalid('observation.url', 'expected an absolute URL or null');
    }
  }
  const nullableCount = (key: string) =>
    source[key] === null ? null : count(source[key], `observation.${key}`);
  return {
    url,
    focusThefts: nullableCount('focusThefts'),
    dialogOpened: nullableCount('dialogOpened'),
    dialogClosed: nullableCount('dialogClosed'),
  };
}

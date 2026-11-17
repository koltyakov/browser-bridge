import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { normalizeRuntimeErrorMessage } from './background-helpers.js';

export type InputAftermath = import('../../../protocol/src/types.js').InputAftermath;
export type InputObservationStatus =
  import('../../../protocol/src/types.js').InputObservationStatus;

export function createInputAftermath(observe: unknown): InputAftermath {
  return {
    dispatch: 'not_started',
    observation: observe
      ? { status: 'unavailable', reason: 'not_started' }
      : { status: 'not_requested' },
    verification: 'not_requested',
  };
}

/** Preserve typed failures, but never turn a potentially dispatched input into
an invitation to replay it. Raw observation errors are not copied into evidence. */
export function inputAftermathError(error: unknown, aftermath: InputAftermath): BridgeError {
  const source =
    error && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown; details?: unknown })
      : {};
  const message = typeof source.message === 'string' ? source.message : String(error);
  const normalized = normalizeRuntimeErrorMessage(message);
  const known = Object.values(ERROR_CODES) as string[];
  const code =
    typeof source.code === 'string' && known.includes(source.code)
      ? (source.code as import('../../../protocol/src/types.js').ErrorCode)
      : known.includes(normalized)
        ? (normalized as import('../../../protocol/src/types.js').ErrorCode)
        : normalized === 'Element reference is stale.'
          ? ERROR_CODES.ELEMENT_STALE
          : ERROR_CODES.INTERNAL_ERROR;
  const details =
    source.details && typeof source.details === 'object' && !Array.isArray(source.details)
      ? (source.details as Record<string, unknown>)
      : {};
  return new BridgeError(code, message, {
    ...details,
    aftermath: { ...aftermath, observation: { ...aftermath.observation } },
    ...(aftermath.dispatch !== 'not_started' ? { outcomeUncertain: true } : {}),
  });
}

export function splitInputObservation(result: Record<string, unknown>): {
  effects: Record<string, unknown>;
  observation: InputObservationStatus;
} {
  const { observation, ...effects } = result;
  if (
    observation &&
    typeof observation === 'object' &&
    'status' in observation &&
    ['not_requested', 'completed', 'unavailable', 'interrupted', 'failed'].includes(
      String(observation.status)
    )
  ) {
    return { effects, observation: observation as InputObservationStatus };
  }
  if (effects.expired === true) {
    delete effects.changed;
    return { effects, observation: { status: 'unavailable', reason: 'expired' } };
  }
  // Older content scripts used "unloading" even for beforeunload or a failed
  // observation. Neither that value nor changed=false establishes what happened.
  delete effects.navigation;
  delete effects.changed;
  return { effects, observation: { status: 'unavailable', reason: 'unsupported' } };
}

import {
  BridgeError,
  ERROR_CODES,
  createSuccess,
  isGatedSensitiveSource,
  normalizeSensitiveReadParams,
} from '../../../protocol/src/index.js';
import type {
  AccessSettings,
  BridgeRequest,
  BridgeResponse,
  NormalizedSensitiveReadParams,
  SensitiveGatedSource,
  SensitiveResponseBodyReadResult,
} from '../../../protocol/src/types.js';
import { getAccessPolicyDenial, sensitiveReadSetting } from './access-settings.js';
import type { RawResponseBody } from './background-cdp-network.js';
import type { ResolvedTabTarget } from './background-tab-bound.js';

type SettingsState = { accessSettings?: AccessSettings; accessSettingsRevision?: string };
type GatedParams = Extract<NormalizedSensitiveReadParams, { source: SensitiveGatedSource }>;

/** One reader per gated source. Adding a source to SensitiveGatedSource makes
 * this record incomplete until a reader exists, so no source ships ungated. */
export type GatedSensitiveReaders = {
  [Source in SensitiveGatedSource]: (
    target: ResolvedTabTarget,
    params: Extract<GatedParams, { source: Source }>
  ) => Promise<unknown>;
};

export type SensitiveReadDependencies = {
  state: SettingsState;
  resolveRequestTarget: (request: BridgeRequest) => Promise<ResolvedTabTarget>;
  /** Returns a check that throws once the window grant changes. */
  captureAccess?: () => () => void;
  readers: GatedSensitiveReaders;
};

/** True when sensitive.read must take the gated background path. Web Storage
 * keeps its content-script path and pre-existing behaviour. */
export function isGatedSensitiveRequest(request: BridgeRequest): boolean {
  return request.method === 'sensitive.read' && isGatedSensitiveSource(request.params?.source);
}

/** Deny unless the user enabled reads for this source. The denial matches
 * the other access settings, so agents can wait with access.wait_for_change. */
export function assertSensitiveDataReadsAllowed(
  state: SettingsState,
  source: SensitiveGatedSource
): void {
  const setting = sensitiveReadSetting(source);
  const label =
    source === 'response_body'
      ? 'Allow reading response bodies'
      : 'Allow reading IndexedDB records';
  if (state.accessSettings?.[setting] === true) return;
  throw new BridgeError(
    ERROR_CODES.ACCESS_DENIED,
    `Reading this sensitive source is disabled. Ask the user to enable "${label}" in the Browser Bridge side panel settings.`,
    { ...getAccessPolicyDenial(state, setting), source }
  );
}

export function createSensitiveReadController(deps: SensitiveReadDependencies) {
  async function handle(request: BridgeRequest): Promise<BridgeResponse> {
    const params = normalizeSensitiveReadParams(request.params);
    if (!isGatedSensitiveSource(params.source))
      throw new BridgeError(ERROR_CODES.INTERNAL_ERROR, 'Storage reads use the content script.');
    const gated = params as GatedParams;
    // Check before any browser work, and again after every await: the user
    // may turn the setting off while the read is in flight.
    assertSensitiveDataReadsAllowed(deps.state, gated.source);
    const assertGrant = deps.captureAccess?.() ?? (() => {});
    const target = await deps.resolveRequestTarget(request);
    assertGrant();
    assertSensitiveDataReadsAllowed(deps.state, gated.source);
    const result = await readGated(target, gated);
    assertGrant();
    assertSensitiveDataReadsAllowed(deps.state, gated.source);
    return createSuccess(request.id, result, { method: request.method });
  }

  function readGated(target: ResolvedTabTarget, params: GatedParams): Promise<unknown> {
    switch (params.source) {
      case 'response_body':
        return deps.readers.response_body(target, params);
      case 'indexeddb':
        return deps.readers.indexeddb(target, params);
    }
  }

  return { handle };
}

/** Turn a raw CDP body into the exact result, or reject it whole. Bytes count
 * the decoded body, so the base64 form stays well under the 1 MiB frame. */
export function decodeResponseBody(
  raw: RawResponseBody,
  encoding: 'text' | 'base64',
  maxBytes: number
): SensitiveResponseBodyReadResult {
  const mimeType = raw.mimeType;
  const result = (body: string, bytes: number): SensitiveResponseBodyReadResult => ({
    source: 'response_body',
    requestId: raw.requestId,
    body,
    encoding,
    mimeType,
    bytes,
    exact: true,
  });
  if (raw.base64Encoded) {
    const bytes = base64ByteLength(raw.body);
    if (bytes > maxBytes) throw tooLarge(bytes, maxBytes, mimeType);
    if (encoding === 'base64') return result(raw.body, bytes);
    let decoded: Uint8Array;
    try {
      decoded = Uint8Array.from(atob(raw.body), (character) => character.charCodeAt(0));
    } catch {
      throw new BridgeError(
        ERROR_CODES.SENSITIVE_TARGET_NOT_FOUND,
        'Chrome returned a malformed response body.',
        { source: 'response_body', reason: 'body_unavailable' }
      );
    }
    let text: string | null = null;
    if (isTextualMimeType(mimeType)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
      } catch {
        text = null;
      }
    }
    if (text === null) throw unsupportedEncoding(bytes, mimeType);
    return result(text, bytes);
  }
  const utf8 = new TextEncoder().encode(raw.body);
  if (utf8.byteLength > maxBytes) throw tooLarge(utf8.byteLength, maxBytes, mimeType);
  return encoding === 'base64'
    ? result(bytesToBase64(utf8), utf8.byteLength)
    : result(raw.body, utf8.byteLength);
}

function tooLarge(bytes: number, maxBytes: number, mimeType: string): BridgeError {
  return new BridgeError(
    ERROR_CODES.RESULT_TOO_LARGE,
    `The response body is too large to return atomically (${bytes} bytes).`,
    {
      source: 'response_body',
      bytes,
      maxBytes,
      mimeType,
      guidance: 'Partial bodies are never returned. Read a narrower request.',
    }
  );
}

function unsupportedEncoding(bytes: number, mimeType: string): BridgeError {
  return new BridgeError(
    ERROR_CODES.INVALID_REQUEST,
    'The response body is binary. Pass encoding: "base64" to read it.',
    {
      source: 'response_body',
      reason: 'unsupported_encoding',
      bytes,
      mimeType,
      guidance: 'Retry deliberately with encoding "base64" only if the binary body is needed.',
    }
  );
}

function isTextualMimeType(mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return (
    type.startsWith('text/') ||
    /\+(json|xml)$/u.test(type) ||
    /^application\/(json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|graphql|x-ndjson|ndjson)$/u.test(
      type
    ) ||
    type === 'image/svg+xml'
  );
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

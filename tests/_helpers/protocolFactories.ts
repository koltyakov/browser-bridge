import {
  PROTOCOL_VERSION,
  createFailure as createBridgeFailure,
  createRequest as createBridgeRequest,
  createSuccess as createBridgeSuccess,
} from '../../packages/protocol/src/index.js';
import type {
  BridgeFailureResponse,
  BridgeMeta,
  BridgeMethod,
  BridgeRequest,
  BridgeSuccessResponse,
  ErrorCode,
} from '../../packages/protocol/src/types.js';

export type TestBridgeMeta = BridgeMeta;
export type TestBridgeMethod = BridgeMethod;
export type TestErrorCode = ErrorCode;
export type TestBridgeRequest = BridgeRequest;
export type TestBridgeSuccessResponse = BridgeSuccessResponse;
export type TestBridgeFailureResponse = BridgeFailureResponse;

export type MakeRequestOptions = {
  id?: string;
  tabId?: number | null;
  params?: Record<string, unknown>;
  meta?: BridgeMeta;
};

export type MakeSuccessOptions = {
  id?: string;
  meta?: BridgeMeta;
};

export type MakeFailureOptions = {
  id?: string;
  details?: unknown;
  meta?: BridgeMeta;
};

// Build the shared protocol metadata envelope used across bridge fixtures.
export function makeMeta(overrides: BridgeMeta = {}): { protocol_version: string } & BridgeMeta {
  return {
    protocol_version: PROTOCOL_VERSION,
    ...overrides,
  };
}

export function makeRequest(method: BridgeMethod, options: MakeRequestOptions = {}): BridgeRequest {
  const { id = 'req_test', tabId = null, params = {}, meta = {} } = options;
  return createBridgeRequest({
    id,
    method,
    tabId,
    params,
    meta,
  });
}

export function makeSuccess(
  result: unknown,
  options: MakeSuccessOptions = {}
): BridgeSuccessResponse {
  const { id = 'req_test', meta = {} } = options;
  return createBridgeSuccess(id, result, meta);
}

export function makeFailure(
  code: ErrorCode,
  message: string,
  options: MakeFailureOptions = {}
): BridgeFailureResponse {
  const { id = 'req_test', details = null, meta = {} } = options;
  return createBridgeFailure(id, code, message, details, meta);
}

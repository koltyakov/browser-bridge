import { createFailure, ERROR_CODES, validateBridgeRequest } from '../../../protocol/src/index.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type BridgeResponse = import('../../../protocol/src/types.js').BridgeResponse;

export type NativePortMessageListenerOptions = {
  handleHostStatusMessage: (message: unknown) => boolean;
  handleBridgeRequest: (request: BridgeRequest) => Promise<void>;
  reply: (response: BridgeResponse) => void;
  reportAsyncError: (error: unknown) => void;
};

function getRequestIdForFailure(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return 'invalid_request';
  }
  const candidate = message as Record<string, unknown>;
  return typeof candidate.id === 'string' && candidate.id.trim() ? candidate.id : 'invalid_request';
}

function getFailureMeta(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') {
    return {};
  }
  const candidate = message as Record<string, unknown>;
  return typeof candidate.method === 'string' ? { method: candidate.method } : {};
}

/** Create the native-port ingress listener used by the background worker so the
request validation boundary can be tested without importing the whole worker. */
export function createNativePortMessageListener(
  options: NativePortMessageListenerOptions
): (message: unknown) => void {
  return (message) => {
    if (options.handleHostStatusMessage(message)) {
      return;
    }

    let request;
    try {
      request = validateBridgeRequest(message);
    } catch (error) {
      options.reply(
        createFailure(
          getRequestIdForFailure(message),
          ERROR_CODES.INVALID_REQUEST,
          error instanceof Error ? error.message : String(error),
          null,
          getFailureMeta(message)
        )
      );
      return;
    }

    void options.handleBridgeRequest(request).catch(options.reportAsyncError);
  };
}

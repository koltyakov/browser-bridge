import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { sameWindowGrant } from './background-access.js';
import { normalizeAgentSession } from './background-agent-tabs.js';

export type BridgeRequest = import('../../../protocol/src/types.js').BridgeRequest;
export type DataScopeDependencies = {
  state: Pick<import('./background-state.js').ExtensionState, 'enabledWindow' | 'nativePort'>;
  disconnectedDataRequests: Set<string>;
  resolveRequestTarget: (
    request: BridgeRequest
  ) => Promise<import('./background-state.js').ResolvedTabTarget>;
};
export type StoreByteArtifact = <K extends import('../../../protocol/src/types.js').ArtifactKind>(
  requestId: string,
  bytes: Uint8Array,
  options: { kind: K; mimeType: string }
) => Promise<import('../../../protocol/src/types.js').ArtifactDescriptor<K>>;

/** Capture transport and window ownership before the first asynchronous lookup. */
export async function resolveDataRequestScope(request: BridgeRequest, deps: DataScopeDependencies) {
  const access = deps.state.enabledWindow ? { ...deps.state.enabledWindow } : null;
  const port = deps.state.nativePort;
  const transportOwner = request.meta?.transport_owner;
  if (typeof transportOwner !== 'string' || !transportOwner) {
    throw new BridgeError(
      ERROR_CODES.ACCESS_DENIED,
      'Data operations require a current daemon connection identity.'
    );
  }
  const assertScope = () => {
    if (
      !sameWindowGrant(access, deps.state.enabledWindow) ||
      port !== deps.state.nativePort ||
      deps.disconnectedDataRequests.has(request.id)
    ) {
      throw new BridgeError(
        ERROR_CODES.ACCESS_DENIED,
        'Data operation access or transport changed.'
      );
    }
  };
  assertScope();
  const target = await deps.resolveRequestTarget(request);
  assertScope();
  const assertAccess = async () => {
    assertScope();
    await deps.resolveRequestTarget({ ...request, tab_id: target.tabId });
    assertScope();
  };
  const owner = `${transportOwner}:${normalizeAgentSession(request.meta?.agent_session)}`;
  return { target, access, transportOwner, owner, assertScope, assertAccess };
}

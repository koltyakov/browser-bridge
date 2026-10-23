import { createSuccess } from '../../../protocol/src/index.js';
import { renderRecording } from './recording-export.js';
import {
  resolveDataRequestScope,
  type BridgeRequest,
  type DataScopeDependencies,
  type StoreByteArtifact,
} from './background-data-scope.js';

export function createRecordingRequestHandler(
  deps: DataScopeDependencies & {
    recordings: ReturnType<typeof import('./background-recording.js').createRecordingController>;
    journals: Pick<
      ReturnType<typeof import('./recording-journal.js').createJournalTransport>,
      'begin'
    >;
    storeByteArtifact: StoreByteArtifact;
  }
) {
  return async (
    request: BridgeRequest
  ): Promise<import('../../../protocol/src/types.js').BridgeResponse> => {
    const { target, owner, assertAccess } = await resolveDataRequestScope(request, deps);
    const p = request.params;
    const id = String(p.sessionId);
    let result;
    switch (request.method) {
      case 'session.start': {
        const journal = p.durable === true ? await deps.journals.begin(request.id) : undefined;
        await assertAccess();
        result = await deps.recordings.start(
          target.tabId,
          owner,
          {
            activity: p.activity === true,
            network: p.network === true,
            bodies: p.bodies === true,
            messages: p.messages === true,
            visual: p.visual === true,
            durationMs: Number(p.durationMs),
            followTabs: p.followTabs === true,
            durable: p.durable === true,
            replay: p.replay === true,
          },
          assertAccess,
          journal
        );
        break;
      }
      case 'session.status':
        result = await deps.recordings.status(target.tabId, owner, id);
        break;
      case 'session.read':
        result = await deps.recordings.read(
          target.tabId,
          owner,
          id,
          Number(p.cursor),
          Number(p.limit),
          Number(p.waitMs)
        );
        break;
      case 'session.stop':
        result = await deps.recordings.stop(target.tabId, owner, id);
        break;
      case 'session.release':
        result = await deps.recordings.release(target.tabId, owner, id);
        break;
      default: {
        const recording = await deps.recordings.exportSession(target.tabId, owner, id);
        await assertAccess();
        const html = p.format === 'html';
        const bytes = new TextEncoder().encode(
          html ? renderRecording(recording) : JSON.stringify(recording)
        );
        const artifact = await deps.storeByteArtifact(request.id, bytes, {
          kind: 'resource',
          mimeType: html ? 'text/html' : 'application/json',
        });
        result = {
          sessionId: id,
          delivery: 'artifact',
          artifact,
          gaps: recording.gaps,
          dropped: recording.dropped,
          journalError: recording.journalError,
          journalId: recording.journalId,
          memoryWindow: recording.memoryWindow,
        };
      }
    }
    await assertAccess();
    return createSuccess(request.id, result, { method: request.method });
  };
}

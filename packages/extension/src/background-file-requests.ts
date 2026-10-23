import { BridgeError, ERROR_CODES, createSuccess } from '../../../protocol/src/index.js';
import { pasteImage, isPasteTargetFocused } from './background-paste.js';
import { assignBrowserFiles, assignStagedFiles, fileBase64 } from './background-files.js';
import { fetchResourceInPage } from './background-resource.js';
import { CONTENT_SCRIPT_TIMEOUT_MS } from './background-state.js';
import {
  resolveDataRequestScope,
  type BridgeRequest,
  type DataScopeDependencies,
  type StoreByteArtifact,
} from './background-data-scope.js';

export function createFileRequestHandler(
  deps: DataScopeDependencies & {
    chrome: typeof globalThis.chrome;
    stagedFiles: ReturnType<typeof import('./background-files.js').createFileStaging>;
    downloads: ReturnType<typeof import('./background-downloads.js').createDownloadController>;
    tabDebugger: import('./debugger-coordinator.js').TabDebuggerCoordinator;
    ensureContentScript: (tabId: number) => Promise<void>;
    getFrameForRef: (tabId: number, elementRef: string) => Promise<number>;
    sendTabMessage: (
      tabId: number,
      message: Record<string, unknown>,
      timeoutMs: number
    ) => Promise<unknown>;
    storeByteArtifact: StoreByteArtifact;
    resourceFetches: Set<number>;
    resourceOwners: Map<number, string>;
  }
) {
  const { chrome, stagedFiles, downloads, tabDebugger } = deps;
  return async (
    request: BridgeRequest
  ): Promise<import('../../../protocol/src/types.js').BridgeResponse> => {
    const {
      target: tab,
      access,
      transportOwner,
      owner: sessionOwner,
      assertScope,
      assertAccess,
    } = await resolveDataRequestScope(request, deps);
    const owner = `${access?.enabledAt}:${sessionOwner}`;
    const p = request.params;
    let result;
    switch (request.method) {
      case 'files.stage':
        result = stagedFiles.stage(p, owner, tab.tabId);
        break;
      case 'files.release':
        result = stagedFiles.release(String(p.transferId), owner, tab.tabId);
        break;
      case 'input.paste_image': {
        const [file] = stagedFiles.resolve([String(p.transferId)], owner, tab.tabId);
        await deps.ensureContentScript(tab.tabId);
        await assertAccess();
        const focused = (await deps.sendTabMessage(
          tab.tabId,
          {
            type: 'bridge.execute',
            method: 'input.focus',
            params: { target: p.target },
          },
          CONTENT_SCRIPT_TIMEOUT_MS
        )) as { elementRef?: string; focused?: boolean };
        if (!focused.focused || !focused.elementRef)
          throw new BridgeError(
            ERROR_CODES.INPUT_FOCUS_CHANGED,
            'Could not focus the paste target.'
          );
        const elementRef = focused.elementRef;
        await assertAccess();
        result = await tabDebugger.runGuarded(tab.tabId, (debugTarget) =>
          pasteImage(
            file.bytes,
            (method, params) => {
              assertScope();
              tabDebugger.assertTaskActive(debugTarget);
              return chrome.debugger.sendCommand(debugTarget, method, params);
            },
            async () => {
              await assertAccess();
              const [checked] = await chrome.scripting.executeScript({
                target: { tabId: tab.tabId },
                func: isPasteTargetFocused,
                args: [elementRef],
              });
              assertScope();
              if (checked?.result !== true)
                throw new BridgeError(
                  ERROR_CODES.INPUT_FOCUS_CHANGED,
                  'Paste target lost focus or is not editable.'
                );
            }
          )
        );
        break;
      }
      case 'download.start':
      case 'download.status':
      case 'download.pause':
      case 'download.resume':
      case 'download.cancel':
      case 'download.release':
        result = await downloads.call(
          request.method,
          p,
          tab.tabId,
          String(access?.enabledAt),
          assertAccess
        );
        break;
      case 'download.resource': {
        if (deps.resourceFetches.size >= 4 || deps.resourceFetches.has(tab.tabId))
          throw new BridgeError(
            ERROR_CODES.INVALID_REQUEST,
            'A resource fetch is already active for this tab or the global limit is reached.'
          );
        deps.resourceFetches.add(tab.tabId);
        deps.resourceOwners.set(tab.tabId, transportOwner);
        try {
          const [fetched] = await chrome.scripting.executeScript({
            target: { tabId: tab.tabId },
            func: fetchResourceInPage,
            args: [String(p.url), Number(p.maxBytes), Number(p.timeoutMs), request.id],
          });
          if (!fetched?.result || 'error' in fetched.result)
            throw new BridgeError(
              ERROR_CODES.INVALID_REQUEST,
              fetched?.result && 'error' in fetched.result
                ? fetched.result.error
                : 'Resource fetch produced no result.'
            );
          await assertAccess();
          const bytes = Uint8Array.from(atob(fetched.result.data), (character) =>
            character.charCodeAt(0)
          );
          const artifact = await deps.storeByteArtifact(request.id, bytes, {
            kind: 'resource',
            mimeType: fetched.result.mimeType,
          });
          result = { delivery: 'artifact', artifact, status: fetched.result.status };
        } finally {
          deps.resourceFetches.delete(tab.tabId);
          deps.resourceOwners.delete(tab.tabId);
        }
        break;
      }
      default: {
        const target = p.target as Record<string, unknown>;
        if (Array.isArray(p.paths)) {
          result = await tabDebugger.runGuarded(tab.tabId, (debugTarget) =>
            assignBrowserFiles(
              (method, params) => {
                assertScope();
                tabDebugger.assertTaskActive(debugTarget);
                return chrome.debugger.sendCommand(debugTarget, method, params);
              },
              String(target.selector),
              p.paths as string[]
            )
          );
        } else {
          const files = stagedFiles.resolve(p.files as string[], owner, tab.tabId);
          await deps.ensureContentScript(tab.tabId);
          const frameId =
            typeof target.elementRef === 'string'
              ? await deps.getFrameForRef(tab.tabId, target.elementRef)
              : 0;
          await assertAccess();
          const [assigned] = await chrome.scripting.executeScript({
            target: { tabId: tab.tabId, frameIds: [frameId] },
            func: assignStagedFiles,
            args: [
              target,
              files.map((file) => ({
                name: file.name,
                mimeType: file.mimeType,
                data: fileBase64(file.bytes),
              })),
            ],
          });
          if (!assigned?.result || 'error' in assigned.result)
            throw new BridgeError(
              ERROR_CODES.INPUT_INVALID_TARGET,
              assigned?.result && 'error' in assigned.result
                ? assigned.result.error
                : 'File assignment produced no result. Inspect the input before retrying.'
            );
          result = assigned.result;
        }
      }
    }
    await assertAccess();
    return createSuccess(request.id, result, { method: request.method });
  };
}

// @ts-check
import { BridgeError, ERROR_CODES } from '../../protocol/src/index.js';
import { fileBase64 } from './background-files.js';

/** Write a PNG to the real clipboard and dispatch Chrome's native paste command.
 * No clipboard read or permission override; Chrome must allow the focused document to write.
 * @param {Uint8Array} bytes
 * @param {(method: string, params: Record<string, unknown>) => Promise<unknown>} send
 * @param {() => Promise<void>} revalidate */
export async function pasteImage(bytes, send, revalidate) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value))
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'Trusted image paste requires a staged PNG.'
    );
  await revalidate();
  const tree = /** @type {{ frameTree: { frame: { id: string } } }} */ (
    await send('Page.getFrameTree', {})
  );
  const world = /** @type {{ executionContextId: number }} */ (
    await send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: 'bbx-clipboard',
      grantUniveralAccess: false,
    })
  );
  const expression = `(async()=>{if(!document.hasFocus()) throw Error('Focus the browser window and target tab before pasting.');
    const bytes=Uint8Array.from(atob(${JSON.stringify(fileBase64(bytes))}),c=>c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);return true;})()`;
  const result = /** @type {{ result?: { value?: unknown }, exceptionDetails?: unknown }} */ (
    await send('Runtime.evaluate', {
      expression,
      contextId: world.executionContextId,
      userGesture: true,
      awaitPromise: true,
      returnByValue: true,
    })
  );
  if (result.exceptionDetails || result.result?.value !== true)
    throw new BridgeError(
      ERROR_CODES.INPUT_FOCUS_CHANGED,
      'Clipboard write failed. Focus the browser window/tab and check clipboard availability. Clipboard may have changed; inspect before retrying.'
    );
  await revalidate();
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'v',
    code: 'KeyV',
    commands: ['Paste'],
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV' });
  return {
    dispatched: true,
    clipboardChanged: true,
    mimeType: 'image/png',
    verify: 'Inspect the editor to confirm insertion before submitting.',
  };
}

/** Runs in the same isolated world as the content reference registry.
 * @param {string} elementRef @returns {boolean} */
export function isPasteTargetFocused(elementRef) {
  const scope =
    /** @type {typeof globalThis & { __BBX_CONTENT_REGISTRY__?: { resolveTarget: (target: { elementRef: string }) => Element } }} */ (
      globalThis
    );
  const element = scope.__BBX_CONTENT_REGISTRY__?.resolveTarget({ elementRef });
  if (!element || !element.isConnected || element.matches(':disabled,[readonly]')) return false;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return Boolean(
    document.hasFocus() &&
    active &&
    (active === element || element.contains(active)) &&
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable))
  );
}

import { BridgeError, ERROR_CODES } from '../../../protocol/src/index.js';
import { fileBase64 } from './background-files.js';

/** Write a PNG to the real clipboard and dispatch Chrome's native paste command.
No clipboard read or permission override; Chrome must allow the focused document to write. */
export async function pasteImage(
  bytes: Uint8Array,
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  revalidate: () => Promise<void>
) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value))
    throw new BridgeError(
      ERROR_CODES.INVALID_REQUEST,
      'Trusted image paste requires a staged PNG.'
    );
  await revalidate();
  const tree = (await send('Page.getFrameTree', {})) as { frameTree: { frame: { id: string } } };
  const world = (await send('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: 'bbx-clipboard',
    grantUniveralAccess: false,
  })) as { executionContextId: number };
  const expression = `(async()=>{if(!document.hasFocus()) throw Error('Focus the browser window and target tab before pasting.');
    const bytes=Uint8Array.from(atob(${JSON.stringify(fileBase64(bytes))}),c=>c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);return true;})()`;
  const result = (await send('Runtime.evaluate', {
    expression,
    contextId: world.executionContextId,
    userGesture: true,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
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

/** Runs in the same isolated world as the content reference registry. */
export function isPasteTargetFocused(elementRef: string): boolean {
  const scope = globalThis as typeof globalThis & {
    __BBX_CONTENT_REGISTRY__?: { resolveTarget: (target: { elementRef: string }) => Element };
  };
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

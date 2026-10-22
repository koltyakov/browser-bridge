import assert from 'node:assert/strict';
import { File as BrowserFile } from 'node:buffer';
import test from 'node:test';
import vm from 'node:vm';
import { withDocument, type DocumentContext } from '../../../tests/_helpers/dom.ts';
import { extensionFile, loadExtensionModule } from '../../../tests/_helpers/extensionBuild.ts';
import { FILE_MAX_BYTES, FILE_TTL_MS } from '../../../protocol/src/files.js';

const { assignStagedFiles, assignBrowserFiles, createFileStaging, fileBase64 } =
  await loadExtensionModule<typeof import('../src/background-files.js')>('src/background-files.js');
const { isPasteTargetFocused, pasteImage } =
  await loadExtensionModule<typeof import('../src/background-paste.js')>('src/background-paste.js');

type FileRegistry = {
  rememberElement: (element: Element) => string;
  resolveTarget: (target: Record<string, unknown>) => Element;
};

async function withFilePage(
  html: string,
  run: (context: DocumentContext & { registry: FileRegistry }) => Promise<void> | void
) {
  await withDocument(html, async (context) => {
    const keys = [
      '__BBX_CONTENT_HELPERS__',
      '__BBX_CONTENT_REGISTRY__',
      '__BBX_CONTENT_DOM_QUERY__',
      'DataTransfer',
      'File',
    ];
    const saved = keys.map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    );
    // Linkedom has no drag data store; preserve actual File bytes at that browser boundary.
    class FileTransfer {
      readonly files: BrowserFile[] = [];
      readonly items = {
        add: (file: BrowserFile) => {
          this.files.push(file);
        },
      };
    }
    try {
      for (const key of keys.slice(0, 3)) Reflect.deleteProperty(globalThis, key);
      Object.defineProperty(globalThis, 'DataTransfer', {
        configurable: true,
        value: FileTransfer,
      });
      Object.defineProperty(globalThis, 'File', { configurable: true, value: BrowserFile });
      for (const name of [
        'content-script-helpers',
        'content-element-registry',
        'content-dom-query',
      ]) {
        await import(`${extensionFile(`src/${name}.js`).href}?case=${crypto.randomUUID()}`);
      }
      await run({
        ...context,
        registry: Reflect.get(globalThis, '__BBX_CONTENT_REGISTRY__') as FileRegistry,
      });
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}

test('staged file assignment resolves labelled inputs and exposes exact files before bubbling input and change', async () => {
  await withFilePage(
    '<html><body><form><label for="upload">Attachments</label><input id="upload" type="file" multiple></form></body></html>',
    async ({ document, registry }) => {
      const input = document.getElementById('upload') as HTMLInputElement;
      Reflect.set(input, 'multiple', true);
      const observed: Array<{ type: string; names: string[] }> = [];
      for (const type of ['input', 'change'])
        document.addEventListener(type, () => {
          observed.push({ type, names: [...(input.files ?? [])].map((file) => file.name) });
        });
      const bytes = Uint8Array.from({ length: 65539 }, (_, index) => index % 256);
      const encoded = fileBase64(bytes);
      assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(bytes));
      const result = assignStagedFiles({ label: 'Attachments' }, [
        { name: 'résumé.bin', mimeType: 'application/octet-stream', data: encoded },
        { name: 'empty.txt', mimeType: 'text/plain', data: '' },
      ]);
      assert.deepEqual(result, { assigned: true, count: 2, totalBytes: bytes.length });
      assert.deepEqual(observed, [
        { type: 'input', names: ['résumé.bin', 'empty.txt'] },
        { type: 'change', names: ['résumé.bin', 'empty.txt'] },
      ]);
      const files = input.files as unknown as BrowserFile[];
      assert.equal(files[0].type, 'application/octet-stream');
      assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), Buffer.from(bytes));
      assert.equal(files[1].size, 0);
      assert.equal(files[1].type, 'text/plain');
      const ref = registry.rememberElement(input);
      assert.deepEqual(assignStagedFiles({ elementRef: ref }, []), {
        assigned: true,
        count: 0,
        totalBytes: 0,
      });
      assert.equal(input.files?.length, 0);
      assert.deepEqual(observed.slice(-2), [
        { type: 'input', names: [] },
        { type: 'change', names: [] },
      ]);

      // Chrome serializes the function into another world; the same byte/event contract must survive it.
      const serialized = vm.runInNewContext(`(${assignStagedFiles.toString()})`, {
        __BBX_CONTENT_REGISTRY__: registry,
        HTMLInputElement,
        DataTransfer,
        File: BrowserFile,
        Event,
        Uint8Array,
        atob,
      }) as typeof assignStagedFiles;
      const serializedResult = serialized({ elementRef: ref }, [
        { name: 'one.txt', mimeType: 'text/plain', data: 'YQ==' },
      ]);
      assert('assigned' in serializedResult && serializedResult.assigned);
      const assignedFile = input.files?.[0];
      assert(assignedFile);
      assert.equal(await assignedFile.text(), 'a');
    }
  );
});

test('file assignment rejects ambiguous, disabled, detached, and incompatible inputs before mutation', async () => {
  await withFilePage(
    '<html><body><input id="first" type="file"><input id="second" type="file"><input id="text"><input id="disabled" type="file" disabled></body></html>',
    ({ document, registry }) => {
      let events = 0;
      document.addEventListener('change', () => {
        events++;
      });
      const file = { name: 'a.txt', mimeType: 'text/plain', data: 'YQ==' };
      const rejected = (target: Record<string, unknown>, files = [file], message = /./) => {
        const result = assignStagedFiles(target, files);
        assert('error' in result);
        assert.match(result.error, message);
        assert.equal(events, 0);
      };
      rejected({ selector: 'input[type=file]' }, [file], /exactly one/);
      rejected({ selector: '#missing' }, [file], /exactly one/);
      rejected({ selector: 'input[type=file]', nth: 9 }, [file], /exactly one/);
      rejected({ selector: '#text' }, [file], /input\[type=file\]/);
      rejected({ selector: '#disabled' }, [file], /disabled/);
      rejected({ selector: '#first' }, [file, file], /multiple/);
      rejected({ selector: '#first' }, [{ ...file, data: 'invalid base64!' }]);
      rejected({}, [file], /unavailable/);
      const first = document.getElementById('first');
      assert(first);
      const ref = registry.rememberElement(first);
      first.remove();
      rejected({ elementRef: ref }, [file], /detached|stale/i);
      const selected = assignStagedFiles({ selector: 'input[type=file]', nth: 0 }, [file]);
      assert.deepEqual(selected, { assigned: true, count: 1, totalBytes: 1 });
      assert.equal(events, 1);
      assert.equal(
        (document.getElementById('second') as HTMLInputElement).files?.[0].name,
        'a.txt'
      );
    }
  );
});

test('staging quotas and owner cleanup release capacity without deleting other connections', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const staging = createFileStaging();
  t.after(() => staging.clearAll());
  assert.throws(
    () => staging.stage({ name: 'bad', size: 1, offset: 1 }, 'owner', 1),
    /start at zero/
  );
  assert.throws(
    () => staging.stage({ name: 'bad', size: 0, data: 'YQ==' }, 'owner', 1),
    /declared size/
  );
  const first = staging.stage(
    { name: 'a', size: FILE_MAX_BYTES },
    'extension:connection-a:session',
    1
  );
  staging.stage({ name: 'b', size: FILE_MAX_BYTES }, 'extension:connection-b:session', 2);
  assert.throws(() => staging.stage({ name: 'overflow', size: 1 }, 'owner', 1), {
    code: 'ARTIFACT_QUOTA_EXCEEDED',
  });
  staging.clearTransportOwner('connection-a');
  assert.throws(() => staging.resolve([first.transferId], 'extension:connection-a:session', 1), {
    code: 'ARTIFACT_NOT_FOUND',
  });
  const kept = staging.stage({ name: 'kept', size: 0 }, 'extension:connection-b:session', 2);
  assert.equal(staging.resolve([kept.transferId], 'extension:connection-b:session', 2).length, 1);
  staging.clearAll();
  assert.throws(() => staging.resolve([kept.transferId], 'extension:connection-b:session', 2), {
    code: 'ARTIFACT_NOT_FOUND',
  });
  for (let index = 0; index < 16; index++)
    staging.stage({ name: `empty-${index}`, size: 0 }, 'owner', 1);
  assert.throws(() => staging.stage({ name: 'seventeenth', size: 0 }, 'owner', 1), {
    code: 'ARTIFACT_QUOTA_EXCEEDED',
  });
  t.mock.timers.tick(FILE_TTL_MS);
  assert.equal(staging.stage({ name: 'after-expiry', size: 0 }, 'owner', 1).complete, true);
});

test('browser-local file assignment validates before mutation and always releases resolved objects', async () => {
  for (const scenario of ['ambiguous', 'disabled', 'mutation-failed', 'count-mismatch'] as const) {
    const calls: string[] = [];
    const send = async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll')
        return { nodeIds: scenario === 'ambiguous' ? [2, 3] : [2] };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'file-input' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(params.objectId, 'file-input');
        if (calls.includes('DOM.setFileInputFiles')) return { result: { value: 0 } };
        return { result: { value: scenario !== 'disabled' } };
      }
      if (method === 'DOM.setFileInputFiles') {
        assert.deepEqual(params, { nodeId: 2, files: ['/browser/report.txt'] });
        if (scenario === 'mutation-failed') throw new Error('Target navigated');
      }
      if (method === 'Runtime.releaseObjectGroup')
        throw new Error('Debugger detached during cleanup');
      return {};
    };
    const assignment = assignBrowserFiles(send, '#file', ['/browser/report.txt']);
    if (scenario === 'count-mismatch')
      assert.deepEqual(await assignment, { assigned: false, count: 0, source: 'browser_paths' });
    else
      await assert.rejects(
        assignment,
        scenario === 'ambiguous'
          ? { code: 'ELEMENT_AMBIGUOUS' }
          : scenario === 'disabled'
            ? { code: 'INPUT_INVALID_TARGET' }
            : /Target navigated/
      );
    assert.equal(
      calls.filter((method) => method === 'DOM.setFileInputFiles').length,
      scenario === 'ambiguous' || scenario === 'disabled' ? 0 : 1
    );
    assert.equal(calls.includes('Runtime.releaseObjectGroup'), scenario !== 'ambiguous');
  }
});

test('paste target focus follows nested shadow editors and rejects readonly or inactive targets', async () => {
  await withFilePage(
    '<html><body><input id="input"><textarea id="textarea"></textarea><div id="host"></div><button id="button">Button</button></body></html>',
    ({ document, registry }) => {
      const input = document.getElementById('input');
      const textarea = document.getElementById('textarea');
      const host = document.getElementById('host');
      const button = document.getElementById('button');
      assert(input && textarea && host && button);
      let active: Element | null = input;
      let documentFocused = true;
      Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active });
      Reflect.set(document, 'hasFocus', () => documentFocused);
      const inputRef = registry.rememberElement(input);
      assert.equal(isPasteTargetFocused(inputRef), true);
      active = textarea;
      assert.equal(isPasteTargetFocused(inputRef), false);
      const textareaRef = registry.rememberElement(textarea);
      assert.equal(isPasteTargetFocused(textareaRef), true);
      textarea.setAttribute('readonly', '');
      assert.equal(isPasteTargetFocused(textareaRef), false);
      textarea.removeAttribute('readonly');
      documentFocused = false;
      assert.equal(isPasteTargetFocused(textareaRef), false);
      documentFocused = true;
      active = button;
      assert.equal(isPasteTargetFocused(registry.rememberElement(button)), false);
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<div id="editor" contenteditable="true"><span>Typed text</span></div>';
      const editor = shadow.querySelector('#editor');
      const span = editor?.querySelector('span');
      assert(editor && span);
      Reflect.set(editor, 'isContentEditable', true);
      active = host;
      Object.defineProperty(shadow, 'activeElement', { configurable: true, value: span });
      assert.equal(isPasteTargetFocused(registry.rememberElement(editor)), true);
      active = null;
      assert.equal(isPasteTargetFocused(inputRef), false);
    }
  );
});

test('image paste writes exact PNG bytes in the isolated world and never pastes after clipboard failure', async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
  for (const clipboardAllowed of [true, false]) {
    const written: Blob[] = [];
    const keys: Array<Record<string, unknown>> = [];
    let checks = 0;
    const send = async (method: string, params: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') {
        assert.deepEqual(params, {
          frameId: 'main',
          worldName: 'bbx-clipboard',
          grantUniveralAccess: false,
        });
        return { executionContextId: 42 };
      }
      if (method === 'Runtime.evaluate') {
        assert.equal(params.contextId, 42);
        const context = {
          document: { hasFocus: () => true },
          navigator: {
            clipboard: {
              write: async (items: Array<{ data: Record<string, Blob> }>) => {
                if (!clipboardAllowed) throw new Error('Permission denied');
                written.push(items[0].data['image/png']);
              },
            },
          },
          ClipboardItem: class {
            constructor(readonly data: Record<string, Blob>) {}
          },
          Blob,
          Uint8Array,
          atob,
        };
        try {
          return {
            result: { value: await vm.runInNewContext(String(params.expression), context) },
          };
        } catch {
          return { exceptionDetails: { text: 'Clipboard unavailable' } };
        }
      }
      if (method === 'Input.dispatchKeyEvent') keys.push(params);
      return {};
    };
    const operation = pasteImage(png, send, async () => {
      checks++;
    });
    if (clipboardAllowed) {
      assert.equal((await operation).clipboardChanged, true);
      assert.equal(checks, 2);
      assert.equal(written[0].type, 'image/png');
      assert.deepEqual(Buffer.from(await written[0].arrayBuffer()), Buffer.from(png));
      assert.deepEqual(
        keys.map((event) => event.type),
        ['keyDown', 'keyUp']
      );
      assert.deepEqual(keys[0].commands, ['Paste']);
    } else {
      await assert.rejects(operation, { code: 'INPUT_FOCUS_CHANGED' });
      assert.equal(checks, 1);
      assert.deepEqual(keys, []);
      assert.deepEqual(written, []);
    }
  }
});

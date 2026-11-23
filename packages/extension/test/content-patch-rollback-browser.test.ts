import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeSkipReason,
  runContentCheckInChrome,
} from '../../../tests/_helpers/contentBrowser.ts';

async function checkRollbackOrder(): Promise<void> {
  type Patches = {
    applyStylePatch: (params: Record<string, unknown>) => unknown;
    applyDomPatch: (params: Record<string, unknown>) => unknown;
    rollbackPatch: (id: string) => { rolledBack: boolean; reason?: string };
  };
  const patches = Reflect.get(globalThis, '__BBX_CONTENT_PATCH__') as Patches;
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
  };
  const code = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return String((error as { code?: unknown }).code);
    }
    return 'no-error';
  };
  document.body.innerHTML = '<div id="t" style="color: red" class="base"></div>';
  const element = document.getElementById('t') as HTMLElement;
  const target = { selector: '#t' };

  patches.applyStylePatch({ patchId: 'a', target, declarations: { color: 'blue' } });
  patches.applyStylePatch({ patchId: 'b', target, declarations: { color: 'green' } });
  equal(
    code(() => patches.rollbackPatch('a')),
    'INVALID_REQUEST',
    'overlapping rollback rejected'
  );
  equal(element.style.color, 'green', 'rejected rollback changes nothing');
  patches.rollbackPatch('b');
  patches.rollbackPatch('a');
  equal(element.style.color, 'red', 'newest-first rollback restores the original');

  patches.applyStylePatch({ patchId: 'c', target, declarations: { color: 'blue' } });
  patches.applyStylePatch({ patchId: 'd', target, declarations: { width: '10px' } });
  equal(
    patches.rollbackPatch('c').rolledBack,
    true,
    'independent properties roll back in any order'
  );
  patches.rollbackPatch('d');

  patches.applyDomPatch({ patchId: 'e', target, operation: 'add_class', value: 'x' });
  patches.applyDomPatch({ patchId: 'f', target, operation: 'add_class', value: 'y' });
  equal(patches.rollbackPatch('e').rolledBack, true, 'different classes commute');
  patches.applyDomPatch({
    patchId: 'g',
    target,
    operation: 'set_attribute',
    name: 'class',
    value: 'z',
  });
  equal(
    code(() => patches.rollbackPatch('f')),
    'INVALID_REQUEST',
    'class attribute write overlaps class patch'
  );
  patches.rollbackPatch('g');
  patches.rollbackPatch('f');
  equal(element.className, 'base', 'class restored');

  patches.applyDomPatch({
    patchId: 'h',
    target,
    operation: 'set_attribute',
    name: 'title',
    value: 'x',
  });
  element.remove();
  const detached = patches.rollbackPatch('h');
  equal(detached.rolledBack, false, 'detached rollback is not reported as restored');
  equal(detached.reason, 'element_detached', 'detached reason');
}

test(
  'overlapping patches roll back newest first and detached rollbacks are reported',
  { skip: chromeSkipReason, timeout: 60_000 },
  async () => {
    const result = await runContentCheckInChrome(checkRollbackOrder);
    assert.ok(result.passed, result.output.replace(/<[^>]+>/g, ''));
  }
);

import type { ExpectedEffect, Task } from './types.ts';

const save: ExpectedEffect = {
  operation: 'save',
  record: 'main',
  count: 1,
  value: 'ada@example.test',
};
const probe: ExpectedEffect = { operation: 'probe', record: 'main', count: 1 };
function task(
  id: string,
  family: string,
  instruction: string,
  expected: readonly ExpectedEffect[],
  options: Partial<Pick<Task, 'fault' | 'headed'>> = {}
): Task {
  return { id, family, instruction, expected, timeoutMs: 30000, settleMs: 1000, ...options };
}

export const tasks: readonly Task[] = [
  task(
    'save',
    'baseline',
    'Set Email to ada@example.test and save the main profile exactly once.',
    [save]
  ),
  task(
    'spa',
    'spa',
    'Open Dashboard, wait for its heading, and save Email as ada@example.test exactly once. Do not reload the document.',
    [{ operation: 'route', record: 'main', count: 1 }, save]
  ),
  task(
    'background',
    'background',
    'Save Email as ada@example.test in the assigned tab without bringing it forward or touching the foreground tab.',
    [save],
    { headed: true }
  ),
  task(
    'dialog-accept',
    'dialogs',
    'Click Confirm save, inspect the native dialog and accept it once. Verify the save.',
    [
      { operation: 'confirm', record: 'main', count: 1 },
      { operation: 'save', record: 'main', count: 1, value: 'confirmed' },
    ]
  ),
  task(
    'dialog-dismiss',
    'dialogs',
    'Click Confirm save, inspect the native dialog and dismiss it. Do not save.',
    [
      { operation: 'confirm', record: 'main', count: 1 },
      { operation: 'dismiss', record: 'main', count: 1 },
    ]
  ),
  task(
    'dialog-inspect',
    'dialogs',
    'Inspect the already-open native confirmation. Do not accept or dismiss it.',
    []
  ),
  task(
    'disconnect',
    'reconnects',
    'Start First then Late as an ordered flow. If interrupted, cancel the remainder, inspect state, and do not replay or resume. Then perform one separate Recovery probe.',
    [{ operation: 'first', record: 'main', count: 1 }, probe],
    { fault: 'mcp_disconnect' }
  ),
  task(
    'disconnect-before',
    'reconnects',
    'If the connection is lost before the First then Late flow starts, do not dispatch either step. Inspect state after reconnect, then perform one separate Recovery probe.',
    [probe],
    { fault: 'mcp_before' }
  ),
  task(
    'disconnect-after-commit',
    'reconnects',
    'Save the main profile with Email ada@example.test once. If the result is lost, inspect current state without resubmitting. Then perform one separate Recovery probe.',
    [save, probe],
    { fault: 'mcp_after_commit' }
  ),
  task(
    'worker-retained',
    'reconnects',
    'Perform one Recovery probe after the browser connection recovers. Do not activate another tab or replay old work.',
    [probe],
    { fault: 'worker_retained' }
  ),
  task(
    'worker-detached',
    'reconnects',
    'Perform one Recovery probe after the browser connection recovers. Do not activate another tab or replay old work.',
    [probe],
    { fault: 'worker_detached' }
  ),
  task(
    'frame-same',
    'frames',
    'Save ada@example.test once in the Payment frame, not the parent profile.',
    [{ operation: 'save', record: 'payment', count: 1, value: 'ada@example.test' }]
  ),
  task(
    'frame-cross',
    'frames',
    'Save ada@example.test once in the cross-origin Payment frame, not the parent profile.',
    [{ operation: 'save', record: 'payment', count: 1, value: 'ada@example.test' }]
  ),
  task(
    'frame-nested',
    'frames',
    'Save ada@example.test once in the nested Payment frame. Leave parent and sibling profiles unchanged.',
    [{ operation: 'save', record: 'payment', count: 1, value: 'ada@example.test' }]
  ),
  task(
    'stale-unique',
    'stale',
    'Save the main profile with ada@example.test once. If the inspected control is replaced, inspect again before a new deliberate action.',
    [save],
    { fault: 'stale_unique' }
  ),
  task(
    'stale-ambiguous',
    'stale',
    'Save the main profile with ada@example.test once, but stop without saving if replacement controls cannot be uniquely identified.',
    [],
    { fault: 'stale_ambiguous' }
  ),
];

export function selectTasks(ids: readonly string[]): readonly Task[] {
  if (!ids.length) return tasks;
  const selected = ids.map((id) => {
    const found = tasks.find((entry) => entry.id === id);
    if (!found) throw new Error(`Unknown benchmark task: ${id}`);
    return found;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate benchmark task');
  return selected;
}

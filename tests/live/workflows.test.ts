import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { nativeExecutable, repoRoot } from '../_helpers/runCli.ts';
import type { BridgeMethod } from '../../protocol/src/types.js';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

// Opt-in public demo workflows. These submit synthetic data to httpbin's echo
// endpoint, not a merchant, and edit only uniquely named todos created here.
// Tabs stay in the background. No personal tab is navigated, resized, or closed.
test(
  'public forms, React editing, delayed controls, and independent working tabs',
  {
    timeout: 240_000,
  },
  async (t) => {
    const profile = process.env.BBX_LIVE_PROFILE_LABEL;
    const requestedExtension = process.env.BBX_LIVE_EXTENSION_ID;
    assert(profile || requestedExtension, 'Set BBX_LIVE_PROFILE_LABEL or BBX_LIVE_EXTENSION_ID.');
    const clients: Client[] = [];
    const tabs: number[] = [];
    const closedTabs = new Set<number>();
    const metrics: Array<Record<string, unknown>> = [];
    const output = path.join(repoRoot, 'dist', 'workflows-live');
    let extensionId: string | undefined;
    let form = 0;
    let todos = 0;
    let dynamic = 0;

    async function connect(name: string) {
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: nativeExecutable,
          args: ['mcp', 'serve'],
          cwd: repoRoot,
          stderr: 'pipe',
          env: Object.fromEntries(
            Object.entries({
              ...process.env,
              BBX_REMOTE: '',
              BBX_AUTO_UPDATE: 'off',
            }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          ),
        })
      );
      clients.push(client);
      return client;
    }

    async function call(
      client: Client,
      method: BridgeMethod,
      params: Record<string, unknown> = {},
      tabId?: number,
      expectedError?: string,
      budgetPreset?: 'quick' | 'normal' | 'deep'
    ) {
      const start = performance.now();
      const result = await client.callTool(
        {
          name: 'browser_call',
          arguments: {
            method,
            params,
            ...(extensionId ? { extensionId } : {}),
            ...(tabId ? { tabId } : {}),
            ...(budgetPreset ? { budgetPreset } : {}),
          },
        },
        { timeout: 40_000 }
      );
      const structured = record(result.structuredContent);
      metrics.push({
        method,
        tabId,
        ms: performance.now() - start,
        bytes: Buffer.byteLength(JSON.stringify(result)),
        ok: structured.ok,
        summary: structured.summary,
        imageCount: result.content.filter((part) => part.type === 'image').length,
        ...(structured.ok === false ? { error: structured.error } : {}),
        ...(method.startsWith('screenshot.baseline.')
          ? {
              status: structured.status,
              equal: structured.equal,
              changedPixels: structured.changedPixels,
            }
          : {}),
      });
      if (
        method === 'health.ping' &&
        structured.ok === false &&
        record(structured.error).code === 'EXTENSION_DISCONNECTED'
      )
        return structured;
      assert.equal(
        result.isError === true,
        Boolean(expectedError),
        JSON.stringify(result.content.filter((part) => part.type === 'text'))
      );
      if (expectedError) assert.equal(record(structured.error).code, expectedError);
      return structured;
    }

    const control = await connect('public-workflow-control');
    try {
      const stamp = record(
        JSON.parse(await readFile(path.join(repoRoot, 'dist/ext/development-build.json'), 'utf8'))
      );
      const readyBy = performance.now() + 75_000;
      for (;;) {
        const discovery = await call(control, 'health.ping');
        if (discovery.ok === false) {
          assert(performance.now() < readyBy, 'The selected profile did not reconnect.');
          extensionId = undefined;
          await delay(500);
          continue;
        }
        const health = record(discovery.evidence);
        assert(Array.isArray(health.connectedExtensions));
        const matches = health.connectedExtensions
          .map(record)
          .filter((connection) =>
            profile
              ? connection.profileLabel === profile
              : connection.extensionId === requestedExtension
          );
        if (matches.length === 0) {
          assert(performance.now() < readyBy, 'The selected profile did not reconnect.');
          extensionId = undefined;
          await delay(500);
          continue;
        }
        assert.equal(matches.length, 1, 'Select one exact browser profile.');
        assert.equal(matches[0].accessEnabled, true);
        extensionId = String(matches[0].extensionId);
        const diagnostics = await call(control, 'health.ping', { diagnostics: true });
        if (diagnostics.ok === false) {
          extensionId = undefined;
          await delay(500);
          continue;
        }
        const loaded = record(diagnostics.evidence);
        if (record(loaded.loadedBuild).sourceDigest === stamp.sourceDigest) break;
        assert(performance.now() < readyBy, 'Chrome did not load the workspace extension build.');
        // Development builds reload on their periodic alarm. Wait before any
        // mutation, and rediscover only the explicitly selected profile.
        extensionId = undefined;
        await delay(500);
      }
      const listed = record((await call(control, 'tabs.list', { limit: 100 })).evidence);
      assert(Array.isArray(listed.tabs));
      const activeBefore = listed.tabs
        .map(record)
        .filter((tab) => tab.active)
        .map((tab) => tab.tabId);
      for (const url of [
        'https://httpbin.org/forms/post',
        'https://demo.playwright.dev/todomvc/#/',
        'https://the-internet.herokuapp.com/dynamic_controls',
      ]) {
        const created = record(
          (await call(control, 'tabs.create', { url, active: false })).evidence
        );
        const id = Number(created.tabId);
        tabs.push(id);
        await call(
          control,
          'page.wait_for_load_state',
          { waitForLoad: true, timeoutMs: 20_000 },
          id
        );
      }
      [form, todos, dynamic] = tabs;
      const formClient = await connect('public-form-session');
      const todoClient = await connect('public-todo-session');
      await t.test('independent MCP sessions retain distinct background working tabs', async () => {
        await call(formClient, 'page.get_state', {}, form);
        await call(todoClient, 'page.get_state', {}, todos);
        assert.match(
          String(record((await call(formClient, 'page.get_state')).evidence).url),
          /httpbin\.org/
        );
        assert.match(
          String(record((await call(todoClient, 'page.get_state')).evidence).url),
          /todomvc/
        );
        const batch = await control.callTool(
          {
            name: 'browser_batch',
            arguments: {
              calls: tabs.map((tabId) => ({
                method: 'page.get_state',
                params: {},
                extensionId,
                tabId,
              })),
            },
          },
          { timeout: 20_000 }
        );
        assert.equal(record(batch.structuredContent).successCount, 3);
      });

      await t.test(
        'fill a public form and verify a real echo submission across navigation',
        async () => {
          const filled = record(
            (
              await call(
                formClient,
                'input.perform',
                {
                  timeoutMs: 10_000,
                  returnLastResult: true,
                  steps: [
                    {
                      method: 'input.fill',
                      params: { target: { label: 'Customer name:' }, value: 'BBX Demo' },
                    },
                    {
                      method: 'input.fill',
                      params: {
                        target: { label: 'E-mail address:' },
                        value: 'bbx-test@example.invalid',
                      },
                    },
                    {
                      method: 'input.fill',
                      params: {
                        target: { label: 'Delivery instructions:' },
                        value: 'BBX echo test only. Not a real order.',
                      },
                    },
                    {
                      method: 'input.set_checked',
                      params: { target: { role: 'radio', name: 'Medium' }, checked: true },
                    },
                    {
                      method: 'input.set_checked',
                      params: { target: { role: 'checkbox', name: 'Extra Cheese' }, checked: true },
                    },
                  ],
                  outcomes: [
                    { kind: 'dom', selector: 'input[type="radio"]:checked', state: 'visible' },
                    { kind: 'dom', selector: 'input[type="checkbox"]:checked', state: 'visible' },
                  ],
                },
                form
              )
            ).evidence
          );
          assert.equal(filled.verified, true);
          const submitted = record(
            (
              await call(
                formClient,
                'input.perform',
                {
                  timeoutMs: 20_000,
                  returnLastResult: true,
                  steps: [
                    {
                      method: 'input.click',
                      params: {
                        target: { role: 'button', name: 'Submit order' },
                        executionMode: 'dom',
                      },
                    },
                    {
                      method: 'page.wait_for_load_state',
                      params: {
                        url: 'https://httpbin.org/post',
                        urlMatch: 'exact',
                        waitForLoad: true,
                      },
                    },
                    { method: 'page.get_text', params: { textBudget: 340 } },
                  ],
                  outcomes: [{ kind: 'url', url: 'https://httpbin.org/post', urlMatch: 'exact' }],
                },
                form
              )
            ).evidence
          );
          assert.equal(submitted.verified, true);
          const echo = record(record(submitted.lastResult).result);
          assert.match(String(echo.text), /BBX Demo/);
          assert.match(String(echo.text), /bbx-test@example\.invalid/);
        }
      );

      await t.test('partial failure preserves state and never recommends replay', async () => {
        const failed = await call(
          todoClient,
          'input.perform',
          {
            timeoutMs: 2000,
            steps: [
              {
                method: 'input.fill',
                params: {
                  target: { placeholder: 'What needs to be done?' },
                  value: 'BBX partial progress',
                },
              },
              {
                method: 'dom.wait_for',
                params: { selector: '[data-bbx-missing-workflow]', timeoutMs: 100 },
              },
              {
                method: 'input.fill',
                params: {
                  target: { placeholder: 'What needs to be done?' },
                  value: 'MUST NOT RUN',
                },
              },
            ],
          },
          todos,
          'TIMEOUT'
        );
        assert.equal(record(failed.recovery).retry, false);
        assert.equal(record(record(failed.error).details).completed, 1);
        const focused = record(
          (
            await call(
              todoClient,
              'input.focus',
              {
                target: { placeholder: 'What needs to be done?' },
                observe: true,
              },
              todos
            )
          ).evidence
        );
        assert.equal(record(record(focused.effects).target).value, 'BBX partial progress');
        await call(
          todoClient,
          'input.fill',
          { target: { placeholder: 'What needs to be done?' }, value: '' },
          todos
        );
      });

      await t.test(
        'React create, nested-text wait, edit, transparent toggle, filter, and owned cleanup',
        async () => {
          const prefix = `BBX live ${crypto.randomUUID()}`;
          const query = record(
            (
              await call(
                todoClient,
                'dom.find_by_role',
                {
                  role: 'checkbox',
                  selector: '.todo-list input[type="checkbox"]',
                  includeHidden: true,
                  maxResults: 50,
                },
                todos,
                undefined,
                'deep'
              )
            ).evidence
          );
          assert.equal(query.truncated, false, 'Do not index an incomplete todo list.');
          const initial = Number(query.count);
          const first = `.todo-list li:nth-child(${initial + 1})`;
          const second = `.todo-list li:nth-child(${initial + 2})`;
          try {
            await call(
              todoClient,
              'input.perform',
              {
                timeoutMs: 10_000,
                steps: [
                  {
                    method: 'input.fill',
                    params: {
                      target: { placeholder: 'What needs to be done?' },
                      value: `${prefix} draft`,
                    },
                  },
                  {
                    method: 'input.press_key',
                    params: { target: { placeholder: 'What needs to be done?' }, key: 'Enter' },
                  },
                  {
                    method: 'input.fill',
                    params: {
                      target: { placeholder: 'What needs to be done?' },
                      value: `${prefix} review`,
                    },
                  },
                  {
                    method: 'input.press_key',
                    params: { target: { placeholder: 'What needs to be done?' }, key: 'Enter' },
                  },
                ],
                outcomes: [
                  {
                    kind: 'dom',
                    selector: second,
                    text: `${prefix} review`,
                    state: 'visible',
                    timeoutMs: 1000,
                  },
                ],
              },
              todos
            );
            const edited = record(
              (
                await call(
                  todoClient,
                  'input.perform',
                  {
                    timeoutMs: 10_000,
                    returnLastResult: true,
                    steps: [
                      {
                        method: 'input.click',
                        params: {
                          target: { selector: `${first} label` },
                          clickCount: 2,
                          executionMode: 'dom',
                        },
                      },
                      // fill emits blur and can commit an inline editor. type retains
                      // focus so this workload deliberately tests an Enter commit.
                      {
                        method: 'input.type',
                        params: {
                          target: { selector: `${first}.editing .edit` },
                          text: `${prefix} edited`,
                          clear: true,
                        },
                      },
                      {
                        method: 'input.press_key',
                        params: { target: { selector: `${first}.editing .edit` }, key: 'Enter' },
                      },
                      {
                        method: 'input.set_checked',
                        params: { target: { selector: `${first} .toggle` }, checked: true },
                      },
                      {
                        method: 'input.click',
                        params: {
                          target: { role: 'link', name: 'Completed' },
                          executionMode: 'dom',
                        },
                      },
                      {
                        method: 'dom.get_text',
                        params: { target: { selector: '.todo-list' }, textBudget: 600 },
                      },
                    ],
                    outcomes: [
                      { kind: 'url', url: '/completed', urlMatch: 'contains' },
                      {
                        kind: 'dom',
                        selector: '.todo-list li.completed',
                        text: `${prefix} edited`,
                        state: 'visible',
                        timeoutMs: 1000,
                      },
                    ],
                  },
                  todos
                )
              ).evidence
            );
            assert.equal(edited.verified, true);
            assert(
              !String(record(record(edited.lastResult).result).text).includes(`${prefix} review`)
            );
          } finally {
            await call(
              todoClient,
              'input.click',
              { target: { role: 'link', name: 'All' }, executionMode: 'dom' },
              todos
            );
            for (const selector of [second, first]) {
              const label = record(
                (
                  await call(
                    todoClient,
                    'dom.get_text',
                    {
                      target: { selector: `${selector} label` },
                      textBudget: 160,
                    },
                    todos
                  )
                ).evidence
              );
              if (!String(label.text).startsWith(prefix)) {
                t.diagnostic(`Ownership changed at ${selector}; did not delete that todo.`);
                continue;
              }
              const patchId = `live-delete-${crypto.randomUUID()}`;
              await call(
                todoClient,
                'patch.apply_styles',
                {
                  target: { selector: `${selector} .destroy` },
                  declarations: { display: 'block' },
                  patchId,
                },
                todos
              );
              try {
                await call(
                  todoClient,
                  'input.click',
                  { target: { selector: `${selector} .destroy` }, executionMode: 'dom' },
                  todos
                );
              } finally {
                await call(todoClient, 'patch.rollback', { patchId }, todos);
              }
            }
          }
        }
      );

      await t.test(
        'semantic state, delayed enable/disable, and stale identity after remount',
        async () => {
          const baseline = record(
            (
              await call(
                control,
                'dom.baseline.create',
                {
                  selector: '#checkbox-example',
                  maxNodes: 15,
                  maxDepth: 4,
                  textBudget: 200,
                  attributeAllowlist: ['type'],
                },
                dynamic
              )
            ).evidence
          );
          try {
            await call(
              control,
              'input.set_checked',
              { target: { selector: '#checkbox input' }, checked: true },
              dynamic
            );
            const diff = record(
              (
                await call(
                  control,
                  'dom.baseline.compare',
                  { baselineId: baseline.baselineId },
                  dynamic
                )
              ).evidence
            );
            assert(Array.isArray(diff.changed));
            const changed = record(diff.changed[0]);
            assert.equal(record(record(changed.before).state).checked, false);
            assert.equal(record(record(changed.after).state).checked, true);
          } finally {
            await call(
              control,
              'input.set_checked',
              { target: { selector: '#checkbox input' }, checked: false },
              dynamic
            );
            await call(
              control,
              'dom.baseline.release',
              { baselineId: baseline.baselineId },
              dynamic
            );
          }
          const enabled = record(
            (
              await call(
                control,
                'input.perform',
                {
                  timeoutMs: 12_000,
                  returnLastResult: true,
                  steps: [
                    {
                      method: 'input.click',
                      params: { target: { role: 'button', name: 'Enable' }, executionMode: 'dom' },
                    },
                    {
                      method: 'input.fill',
                      params: {
                        target: { selector: '#input-example input' },
                        value: 'BBX auto-wait',
                        timeoutMs: 6000,
                      },
                    },
                  ],
                  outcomes: [
                    {
                      kind: 'dom',
                      selector: '#input-example input:enabled',
                      state: 'visible',
                      timeoutMs: 1000,
                    },
                  ],
                },
                dynamic
              )
            ).evidence
          );
          assert(
            Number(record(record(record(enabled.lastResult).result).resolution).waitedMs) >= 1000
          );
          await call(
            control,
            'input.fill',
            { target: { selector: '#input-example input' }, value: '' },
            dynamic
          );
          await call(
            control,
            'input.perform',
            {
              timeoutMs: 10_000,
              steps: [
                {
                  method: 'input.click',
                  params: { target: { role: 'button', name: 'Disable' }, executionMode: 'dom' },
                },
              ],
              outcomes: [
                {
                  kind: 'dom',
                  selector: '#input-example input:disabled',
                  state: 'visible',
                  timeoutMs: 6000,
                },
              ],
            },
            dynamic
          );
          const queried = (
            await call(
              control,
              'dom.query',
              {
                selector: '#checkbox input',
                maxNodes: 1,
                maxDepth: 1,
                textBudget: 32,
                attributeAllowlist: ['type'],
              },
              dynamic
            )
          ).evidence;
          assert(Array.isArray(queried));
          const oldRef = record(queried[0]).ref;
          await call(
            control,
            'input.perform',
            {
              timeoutMs: 15_000,
              steps: [
                {
                  method: 'input.click',
                  params: { target: { role: 'button', name: 'Remove' }, executionMode: 'dom' },
                },
                {
                  method: 'dom.wait_for',
                  params: { selector: '#checkbox', state: 'detached', timeoutMs: 6000 },
                },
                {
                  method: 'input.click',
                  params: { target: { role: 'button', name: 'Add' }, executionMode: 'dom' },
                },
                {
                  method: 'dom.wait_for',
                  params: { selector: '#checkbox', state: 'visible', timeoutMs: 6000 },
                },
              ],
            },
            dynamic
          );
          await call(
            control,
            'input.set_checked',
            { target: { elementRef: oldRef }, checked: true, timeoutMs: 0 },
            dynamic,
            'ELEMENT_STALE'
          );
        }
      );

      await t.test(
        'visual baselines detect CSS changes, rollback, and geometry invalidation',
        async () => {
          const stableId = `live-no-motion-${crypto.randomUUID()}`;
          await call(
            control,
            'patch.apply_styles',
            {
              target: { selector: '#checkbox-example button' },
              declarations: { transition: 'none', animation: 'none' },
              patchId: stableId,
            },
            dynamic
          );
          const baseline = await call(
            control,
            'screenshot.baseline.create',
            { selector: '#checkbox-example' },
            dynamic
          );
          const baselineId = baseline.baselineId;
          const patchId = `live-visual-${crypto.randomUUID()}`;
          const geometryId = `live-geometry-${crypto.randomUUID()}`;
          try {
            const unchanged = await call(
              control,
              'screenshot.baseline.compare',
              { baselineId },
              dynamic
            );
            assert.equal(unchanged.equal, true);
            await call(
              control,
              'patch.apply_styles',
              {
                target: { selector: '#checkbox-example button' },
                declarations: { color: '#ff00aa' },
                patchId,
              },
              dynamic
            );
            try {
              const changed = await call(
                control,
                'screenshot.baseline.compare',
                { baselineId },
                dynamic
              );
              assert.equal(changed.equal, false);
              assert(Number(changed.changedPixels) > 0);
            } finally {
              await call(control, 'patch.rollback', { patchId }, dynamic);
            }
            assert.equal(
              (await call(control, 'screenshot.baseline.compare', { baselineId }, dynamic)).equal,
              true
            );
            await call(
              control,
              'patch.apply_styles',
              {
                target: { selector: '#checkbox-example' },
                declarations: { 'padding-bottom': '24px' },
                patchId: geometryId,
              },
              dynamic
            );
            try {
              const geometry = await call(
                control,
                'screenshot.baseline.compare',
                { baselineId },
                dynamic
              );
              assert.equal(geometry.status, 'not_comparable');
              assert.equal(geometry.requiresNewBaseline, true);
            } finally {
              await call(control, 'patch.rollback', { patchId: geometryId }, dynamic);
            }
          } finally {
            await call(control, 'screenshot.baseline.release', { baselineId }, dynamic);
            await call(control, 'patch.rollback', { patchId: stableId }, dynamic);
          }
          const released = await call(
            control,
            'screenshot.baseline.release',
            { baselineId },
            dynamic
          );
          assert.equal(released.released, false);
          await call(
            control,
            'screenshot.baseline.compare',
            { baselineId },
            dynamic,
            'VISUAL_BASELINE_NOT_FOUND'
          );
        }
      );

      await t.test(
        'background mobile emulation resets without changing the foreground tab',
        async () => {
          const before = record(
            record((await call(todoClient, 'page.get_state', {}, todos)).evidence).viewport
          );
          try {
            await call(todoClient, 'viewport.resize', { width: 820, height: 1024 }, todos);
            const tablet = record((await call(todoClient, 'page.get_state', {}, todos)).evidence);
            assert.equal(record(tablet.viewport).width, 820);
            await call(todoClient, 'viewport.resize', { width: 375, height: 812 }, todos);
            const mobile = record((await call(todoClient, 'page.get_state', {}, todos)).evidence);
            // Without a viewport meta tag, mobile Chrome keeps a ~980 CSS-px
            // layout viewport. Device screen width and layout width differ.
            const screen = record(
              record(
                (
                  await call(
                    todoClient,
                    'page.evaluate',
                    {
                      expression: '({screenWidth:screen.width,layoutWidth:innerWidth})',
                    },
                    todos
                  )
                ).evidence
              ).value
            );
            assert.equal(screen.screenWidth, 375);
            assert.equal(screen.layoutWidth, record(mobile.viewport).width);
            assert.equal(record(mobile.scroll).maxX, 0);
          } finally {
            await call(todoClient, 'viewport.resize', { reset: true }, todos);
          }
          // CDP acknowledgement precedes Chrome's resize event in a background
          // tab. Observe the postcondition; never replay the reset command.
          let after: Record<string, unknown> = {};
          const resetBy = performance.now() + 3000;
          do {
            after = record(
              record((await call(todoClient, 'page.get_state', {}, todos)).evidence).viewport
            );
            if (after.width === before.width && after.height === before.height) break;
            await delay(50);
          } while (performance.now() < resetBy);
          assert.deepEqual(after, before);
          const current = record((await call(control, 'tabs.list', { limit: 100 })).evidence);
          assert(Array.isArray(current.tabs));
          assert.deepEqual(
            current.tabs
              .map(record)
              .filter((tab) => tab.active)
              .map((tab) => tab.tabId),
            activeBefore
          );
        }
      );
      await t.test('closing one working tab never retargets either MCP session', async () => {
        await call(control, 'tabs.close', { tabId: form });
        closedTabs.add(form);
        const closed = await call(formClient, 'page.get_state', {}, undefined, 'TAB_MISMATCH');
        assert.equal(record(record(closed.error).details).reason, 'working_tab_closed');
        const survivor = record((await call(todoClient, 'page.get_state')).evidence);
        assert.match(String(survivor.url), /todomvc/);
      });
    } finally {
      for (const tabId of tabs.reverse()) {
        if (closedTabs.has(tabId)) continue;
        try {
          await call(control, 'tabs.close', { tabId });
        } catch (error) {
          t.diagnostic(`Could not close task tab ${tabId}: ${String(error)}`);
        }
      }
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
      for (const client of clients) await client.close();
    }
  }
);

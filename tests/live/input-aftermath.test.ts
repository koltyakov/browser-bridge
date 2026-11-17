import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { transform } from 'esbuild';
import { BridgeError, createFailure } from '../../protocol/src/index.js';
import { InputLiveBrowser, type InputLivePage } from '../_helpers/inputLiveBrowser.ts';
import { object } from '../_helpers/chromePipe.ts';
import { repoRoot } from '../_helpers/runCli.ts';

// Actual pre-aftermath source, compiled unchanged at runtime, not fabricated
// response fixtures. A shallow checkout must supply this history explicitly.
const defaultLegacyRef = '45f35307a1b46daa36de196df405dbe7ed39e11a';
const exec = promisify(execFile);

test(
  'isolated input safety, observer faults, and genuine legacy observations',
  { timeout: 120000 },
  async (t) => {
    const executable = process.env.BBX_INPUT_CHROME;
    assert(
      executable && path.isAbsolute(executable),
      'Set BBX_INPUT_CHROME to an absolute Chrome for Testing/Chromium executable.'
    );
    const legacyRef = process.env.BBX_INPUT_LEGACY_REF ?? defaultLegacyRef;
    assert(/^[a-f0-9]{40}$/.test(legacyRef), 'BBX_INPUT_LEGACY_REF must be a full commit SHA.');
    let legacySource: string;
    try {
      legacySource = (
        await exec('git', ['show', `${legacyRef}:packages/extension/src/content-input.ts`], {
          cwd: repoRoot,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      throw new Error(
        `Legacy source ${legacyRef} is unavailable. Fetch that history or set BBX_INPUT_LEGACY_REF to an available pre-aftermath commit.`,
        { cause: error }
      );
    }
    assert(
      !legacySource.includes('InputAftermath'),
      'The legacy source must predate aftermath metadata.'
    );
    const legacyCode = (
      await transform(legacySource, { loader: 'ts', target: 'chrome114', format: 'iife' })
    ).code;
    const output = path.join(repoRoot, 'dist', 'input-live');
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(output, 'run-'));
    const browser = new InputLiveBrowser(root);
    const measurements: Array<Record<string, unknown>> = [];
    let passed = false;
    t.after(async () => {
      let cleaned = false;
      try {
        await browser.close();
        cleaned = true;
      } finally {
        await writeFile(
          path.join(root, 'results.json'),
          JSON.stringify(
            {
              passed,
              cleaned,
              browser: browser.version,
              emittedModuleHashes: browser.hashes,
              legacyRef,
              legacySourceSHA256: createHash('sha256').update(legacySource).digest('hex'),
              boundary:
                'Real disposable headless Chrome and isolated-world content code. The native controller uses direct CDP/content adapters, not the installed extension, native host, daemon, or MCP transport.',
              measurements,
            },
            null,
            2
          )
        );
      }
    });
    await writeFile(path.join(root, 'progress.json'), JSON.stringify({ stage: 'browser startup' }));
    await browser.start(executable);
    t.diagnostic(`Synthetic evidence: ${path.join(root, 'results.json')}`);

    async function scenario(
      name: string,
      run: (page: InputLivePage) => Promise<Record<string, unknown>>,
      legacy = false
    ) {
      let failed = false;
      await writeFile(
        path.join(root, 'progress.json'),
        JSON.stringify({ stage: name, measurements }, null, 2)
      );
      await t.test(name, async (child) => {
        let page: InputLivePage | undefined;
        try {
          page = await browser.page(legacy ? legacyCode : undefined);
          const openedPage = page;
          child.after(async () => {
            try {
              await openedPage.close();
            } catch (error) {
              failed = true;
              throw error;
            }
          });
          const evidence = await run(page);
          measurements.push({ name, passed: true, ...evidence });
          await writeFile(
            path.join(root, 'progress.json'),
            JSON.stringify({ stage: `${name}: cleanup`, measurements }, null, 2)
          );
        } catch (error) {
          failed = true;
          measurements.push({
            name,
            passed: false,
            error: String(error),
            commands: page?.commands,
            responses: page?.responses,
          });
          throw error;
        }
      });
      assert(!failed, 'Stop after a failed live scenario; inspect the saved evidence.');
    }

    for (const mode of ['dom', 'cdp'] as const) {
      for (const fault of ['constructor', 'observe'] as const) {
        await scenario(
          `${mode}: thrown observer ${fault}, exact-once action and restored observation`,
          async (page) => {
            await page.fault(fault);
            const result = mode === 'dom' ? await page.dom() : await page.native();
            const metrics = await page.restore();
            assert.deepEqual(object(result.aftermath), {
              dispatch: 'completed',
              observation: { status: 'unavailable', reason: 'start_failed' },
              verification: 'not_requested',
            });
            assert.equal(result.effects, undefined);
            assert.doesNotMatch(JSON.stringify(result), /BBX_TEST_ONLY_OBSERVER_THROW/);
            assert(metrics);
            assert.equal(metrics.constructors, 1);
            assert.equal(metrics.throws, 1);
            assert.equal(metrics.disconnectCalls, fault === 'observe' ? 1 : 0);
            assert.equal(metrics.restored, true);
            assert.equal((await page.state()).clicks, 1);
            const recovered = mode === 'dom' ? await page.dom() : await page.native();
            assert.equal(object(object(recovered.aftermath).observation).status, 'completed');
            const state = await page.state();
            assert.equal(state.clicks, 2);
            assert.equal(state.trusted, mode === 'cdp' ? 2 : 0);
            assert.equal(state.mainObserverUnchanged, true);
            return { result, metrics, recovered, state };
          }
        );
      }
    }

    await scenario(
      'thrown finish read preserves acknowledged native input and disposes the observer',
      async (page) => {
        await page.fault('finish');
        const result = await page.native();
        const metrics = await page.restore();
        assert.deepEqual(result.aftermath, {
          dispatch: 'completed',
          observation: { status: 'failed', reason: 'finish_failed' },
          verification: 'not_requested',
        });
        assert.equal(result.effects, undefined);
        assert.doesNotMatch(JSON.stringify(result), /BBX_TEST_ONLY_OBSERVER_THROW/);
        assert.equal(metrics?.throws, 1);
        assert.equal(metrics?.disconnectCalls, 1);
        assert.equal(metrics?.restored, true);
        assert.equal((await page.state()).clicks, 1);
        const recovered = await page.native();
        assert.equal(object(object(recovered.aftermath).observation).status, 'completed');
        assert.equal((await page.state()).clicks, 2);
        return { result, metrics, recovered };
      }
    );

    await scenario('native fill confirms a real empty field before insertion', async (page) => {
      const result = await page.native('input.fill', {
        target: { selector: '#text' },
        value: 'replacement',
      });
      assert.equal(result.value, 'replacement');
      assert.equal((await page.state()).value, 'replacement');
      const reads = page.responses
        .filter((entry) => entry.method === 'input.read_value')
        .map((entry) => entry.response.value);
      assert.deepEqual(reads, ['', 'replacement']);
      assert.equal(page.commands.filter((entry) => entry.method === 'Input.insertText').length, 1);
      const empty = await page.native('input.fill', { target: { selector: '#text' }, value: '' });
      assert.equal(empty.value, '');
      assert.equal((await page.state()).value, '');
      assert.equal(page.commands.filter((entry) => entry.method === 'Input.insertText').length, 1);
      return { result, reads, empty };
    });

    await scenario(
      'prevented native deletion cannot append replacement text or replay clearing',
      async (page) => {
        await page.evaluate('window.blockNativeClear(true)', false);
        await assert.rejects(
          page.native('input.fill', { target: { selector: '#text' }, value: 'replacement' }),
          (error: unknown) => {
            assert(error instanceof BridgeError);
            assert.equal(object(error.details).reason, 'native_clear_not_confirmed');
            assert.equal(object(object(error.details).aftermath).dispatch, 'uncertain');
            assert.equal(
              createFailure('clear', error.code, error.message, error.details, {
                method: 'input.fill',
              }).error.recovery?.retry,
              false
            );
            return true;
          }
        );
        const state = await page.state();
        assert.equal(state.value, 'existing');
        assert.equal(
          page.commands.filter((entry) => entry.method === 'Input.insertText').length,
          0
        );
        assert.equal(
          page.commands.filter(
            (entry) => entry.params.code === 'KeyA' && entry.params.type === 'keyDown'
          ).length,
          1
        );
        return { state, commands: page.commands };
      }
    );

    await scenario(
      'background key flows fail before dispatch while insertText remains supported',
      async (page) => {
        await page.evaluate(
          `(() => {
          const input=document.querySelector('#text');
          input.setSelectionRange(input.value.length,input.value.length);
        })()`,
          false
        );
        const other = await browser.page();
        try {
          assert.equal(await page.evaluate('document.visibilityState', false), 'hidden');
          for (const [method, params] of [
            ['input.fill', { target: { selector: '#text' }, value: 'replacement' }],
            ['input.press_key', { key: 'Enter' }],
            ['input.type', { target: { selector: '#text' }, text: 'replacement', clear: true }],
            ['input.type', { target: { selector: '#text' }, text: 'append', submit: true }],
          ] as const) {
            await assert.rejects(page.native(method, params), (error: unknown) => {
              assert(error instanceof BridgeError);
              assert.equal(object(error.details).reason, 'inactive_native_keyboard_target');
              assert.equal(object(object(error.details).aftermath).dispatch, 'not_started');
              return true;
            });
          }
          assert.equal(page.commands.length, 0);
          assert.equal(page.responses.length, 0);
          const result = await page.native('input.type', {
            target: { selector: '#text' },
            text: ' appended',
            clear: false,
            submit: false,
            observe: false,
          });
          const state = await page.state();
          assert.equal(state.value, 'existing appended');
          assert.deepEqual(
            page.commands.map((entry) => entry.method),
            ['Input.insertText']
          );
          return { result, state };
        } finally {
          await other.close();
        }
      }
    );

    for (const kind of ['effects', 'beforeunload', 'expired'] as const) {
      await scenario(
        `genuine legacy content observation: ${kind}`,
        async (page) => {
          if (kind === 'expired') page.expireObservation = true;
          const result = await page.native('input.click', {
            target: { selector: kind === 'beforeunload' ? '#signal' : '#save' },
          });
          const raw = page.responses.find(
            (entry) => entry.method === 'input.observe_finish'
          )?.response;
          assert(raw);
          assert.equal(
            raw.observation,
            undefined,
            'This must be a real metadata-less legacy response.'
          );
          const effects = object(result.effects ?? {});
          assert.equal(effects.navigation, undefined);
          assert.equal(effects.changed, undefined);
          assert.deepEqual(object(result.aftermath).observation, {
            status: 'unavailable',
            reason: kind === 'expired' ? 'expired' : 'unsupported',
          });
          if (kind === 'beforeunload') {
            assert.equal(
              raw.navigation,
              'unloading',
              'The old implementation genuinely overclaimed navigation.'
            );
            assert.equal(await page.evaluate('location.href', false), 'about:blank');
          } else if (kind === 'expired') {
            assert.equal(raw.expired, true);
            assert.equal(raw.changed, false);
          } else {
            assert.equal(raw.changed, true);
            assert(Array.isArray(raw.messages));
            assert(raw.messages.some((message: unknown) => object(message).text === 'Saved 1'));
            assert.deepEqual(effects.messages, raw.messages);
            assert.equal((await page.state()).clicks, 1);
          }
          return { result, rawLegacyResponse: raw };
        },
        true
      );
    }
    passed = true;
  }
);

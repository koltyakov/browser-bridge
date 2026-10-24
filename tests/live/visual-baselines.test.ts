import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { nativeExecutable, repoRoot } from '../_helpers/runCli.ts';
import { decodeTestPng, type PngPixels } from '../_helpers/png.ts';
import type {
  BridgeMethod,
  VisualBaselineCompareResult,
  VisualBaselineDescriptor,
  VisualRect,
} from '../../protocol/src/types.js';

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function images(result: CallToolResult): Array<{ data: string; mimeType: string }> {
  assert(Array.isArray(result.content));
  return result.content
    .filter((part) => part.type === 'image')
    .map((part) => {
      assert(part.type === 'image');
      return { data: part.data, mimeType: part.mimeType };
    });
}

function imageTokens(width: number, height: number): number {
  // Documented GPT-4o high-detail estimate, not measured API billing.
  const scale = Math.min(1, 2048 / Math.max(width, height), 768 / Math.min(width, height));
  return 85 + 170 * Math.ceil((width * scale) / 512) * Math.ceil((height * scale) / 512);
}

function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function verifyPixels(
  before: PngPixels,
  after: PngPixels,
  compared: VisualBaselineCompareResult,
  blocks: Array<{ data: string }>
): number {
  assert.equal(before.width, after.width);
  assert.equal(before.height, after.height);
  assert.equal(compared.comparable, true);
  let count = 0;
  let left = before.width;
  let top = before.height;
  let right = 0;
  let bottom = 0;
  const rectangles = compared.images
    .filter((image) => image.phase === 'after')
    .map((image) => image.rect);
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const offset = (y * before.width + x) * 4;
      if (
        before.rgba
          .subarray(offset, offset + 4)
          .every((channel, index) => channel === after.rgba[offset + index])
      )
        continue;
      count++;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
      if (rectangles.length)
        assert(
          rectangles.some(
            (rect) =>
              x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
          ),
          `changed pixel ${x},${y} omitted`
        );
    }
  }
  assert.equal(
    compared.changedPixels,
    count,
    'native changed-pixel count must match independently captured/decoded originals'
  );
  assert.equal(compared.equal, count === 0);
  assert.deepEqual(
    compared.changedRect,
    count ? { x: left, y: top, width: right - left, height: bottom - top } : null
  );
  if (count && !rectangles.length) {
    assert.equal(compared.status, 'diff_not_useful');
    assert.equal(compared.strategy, 'none');
    assert.equal(compared.advanced, false);
    assert.equal(compared.requiresNewBaseline, false);
  }
  assert.equal(compared.images.length, blocks.length);
  assert.equal(
    JSON.stringify(compared).includes('base64'),
    false,
    'MCP metadata must not include image bytes'
  );
  for (const [index, evidence] of compared.images.entries()) {
    const crop = decodeTestPng(Buffer.from(blocks[index].data, 'base64'));
    const source = evidence.phase === 'before' ? before : after;
    assert.equal(crop.width, evidence.rect.width);
    assert.equal(crop.height, evidence.rect.height);
    for (let y = 0; y < crop.height; y++) {
      const from = ((evidence.rect.y + y) * source.width + evidence.rect.x) * 4;
      assert.deepEqual(
        crop.rgba.subarray(y * crop.width * 4, (y + 1) * crop.width * 4),
        source.rgba.subarray(from, from + crop.width * 4),
        `crop row ${y} differs from original ${evidence.phase}`
      );
    }
  }
  return count;
}

test(
  'real Chrome visual verification and opt-in regression benchmark',
  { timeout: 300_000 },
  async (t) => {
    const html = await readFile(
      new URL('../fixtures/visual-baselines/index.html', import.meta.url)
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(html);
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const output = path.join(
      repoRoot,
      'dist',
      'visual-live',
      new Date().toISOString().replaceAll(':', '-')
    );
    await mkdir(output, { recursive: true });
    const rows: Array<Record<string, unknown>> = [];
    const handles = new Set<string>();
    const semanticHandles = new Set<string>();
    const session = `visual-live-${Date.now()}`;
    const transport = new StdioClientTransport({
      command: nativeExecutable,
      args: ['mcp', 'serve'],
      cwd: repoRoot,
      stderr: 'pipe',
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          BBX_REMOTE: '',
          BBX_AUTO_UPDATE: 'off',
          BBX_SESSION: session,
        }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      ),
    });
    const client = new Client(
      { name: 'visual-live-verification', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    let extensionId: string | undefined;
    let tabId: number | undefined;
    let viewportOverridden = false;
    let runMetadata: Record<string, unknown> = {};

    async function raw(method: BridgeMethod, params: Record<string, unknown> = {}, target = tabId) {
      await appendFile(
        path.join(output, 'requests.jsonl'),
        JSON.stringify({ method, state: 'started', at: new Date().toISOString() }) + '\n'
      );
      const start = performance.now();
      const result = await client.callTool(
        {
          name: 'browser_call',
          arguments: {
            method,
            params,
            ...(extensionId ? { extensionId } : {}),
            ...(target ? { tabId: target } : {}),
          },
        },
        { timeout: 20000 }
      );
      const ms = performance.now() - start;
      await appendFile(
        path.join(output, 'requests.jsonl'),
        JSON.stringify({ method, state: 'finished', ms, isError: result.isError ?? false }) + '\n'
      );
      const structured = record(result.structuredContent);
      const evidence =
        method.startsWith('screenshot.') || method === 'protocol.describe'
          ? structured
          : Array.isArray(structured.evidence)
            ? { nodes: structured.evidence }
            : typeof structured.evidence === 'string'
              ? { text: structured.evidence }
              : record(structured.evidence ?? {});
      return { result, evidence, ms, structured };
    }
    async function call(
      method: BridgeMethod,
      params: Record<string, unknown> = {},
      target = tabId
    ) {
      const response = await raw(method, params, target);
      if (response.result.isError || response.structured.ok === false) {
        assert.fail(`${method}: ${JSON.stringify(response.result.content)}`);
      }
      return response;
    }
    async function evaluate(expression: string) {
      return (await call('page.evaluate', { expression, awaitPromise: true })).evidence.value;
    }
    async function settle(statement = '') {
      await evaluate(
        `(async () => { ${statement}; await document.fonts.ready; document.documentElement.getBoundingClientRect(); return true; })()`
      );
    }
    async function create(params: Record<string, unknown> = { selector: '#board' }) {
      const response = await call('screenshot.baseline.create', params);
      assert.equal(images(response.result).length, 0);
      const descriptor = response.evidence as unknown as VisualBaselineDescriptor;
      assert.match(descriptor.baselineId, /^visual_[a-f0-9]{32}$/u);
      handles.add(descriptor.baselineId);
      return descriptor;
    }
    async function release(baselineId: string) {
      const response = await call('screenshot.baseline.release', { baselineId });
      handles.delete(baselineId);
      return response.evidence;
    }
    async function capture(rect: VisualRect) {
      const response = await call('screenshot.capture_region', {
        ...rect,
        scale: 1,
        delivery: 'inline',
        format: 'png',
      });
      const blocks = images(response.result);
      assert.equal(blocks.length, 1);
      const bytes = Buffer.from(blocks[0].data, 'base64');
      return { ...response, bytes, pixels: decodeTestPng(bytes) };
    }
    async function stableScene() {
      const box = record(
        await evaluate(
          `(() => { const r = document.getElementById('board').getBoundingClientRect(); return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}; })()`
        )
      );
      const rect = {
        x: Number(box.x),
        y: Number(box.y),
        width: Number(box.width),
        height: Number(box.height),
      };
      let previous: PngPixels | undefined;
      let matches = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = (await capture(rect)).pixels;
        matches =
          previous &&
          previous.width === current.width &&
          previous.height === current.height &&
          Buffer.from(previous.rgba).equals(Buffer.from(current.rgba))
            ? matches + 1
            : 0;
        if (matches >= 2) return;
        previous = current;
      }
      assert.fail('independent source captures did not stabilize after emulation');
    }
    async function scenario(name: string, run: () => Promise<void>) {
      await t.test(name, async () => {
        try {
          await run();
        } catch (error: unknown) {
          rows.push({
            scenario: name,
            passed: false,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          for (const baselineId of handles) await release(baselineId);
          if (viewportOverridden && tabId) {
            await call('viewport.resize', { reset: true });
            viewportOverridden = false;
          }
          for (const baselineId of semanticHandles) {
            await call('dom.baseline.release', { baselineId });
            semanticHandles.delete(baselineId);
          }
        }
      });
    }

    try {
      await client.connect(transport, { timeout: 15000 });
      const tools = await client.listTools();
      assert.match(
        tools.tools.find((tool) => tool.name === 'browser_call')?.description ?? '',
        /Only when DOM diffs/
      );
      const health = (await call('health.ping')).evidence;
      const profiles = health.connectedExtensions;
      assert(Array.isArray(profiles));
      const enabled = profiles.map(record).filter((profile) => profile.accessEnabled === true);
      const selected = process.env.BBX_LIVE_EXTENSION_ID
        ? enabled.find((profile) => profile.extensionId === process.env.BBX_LIVE_EXTENSION_ID)
        : enabled.length === 1
          ? enabled[0]
          : undefined;
      assert(
        selected && typeof selected.extensionId === 'string',
        'Enable exactly one Chrome profile, or set BBX_LIVE_EXTENSION_ID. No access/focus settings are changed by this test.'
      );
      extensionId = selected.extensionId;
      runMetadata = {
        daemonBuild: health.daemonVersionName,
        extensionBuild: health.loadedBuild
          ? record(health.loadedBuild).sourceDigest
          : 'omitted_by_compact_health',
        tokenEstimate: 'GPT-4o high detail dimensions only, no API billing measured',
        origin,
      };
      const discovered = await call('protocol.describe', { method: 'screenshot.baseline.compare' });
      assert(
        record(discovered.evidence.inputSchema).properties,
        'running native runtime must include visual-baseline support'
      );
      const created = await call('tabs.create', { url: origin, active: false });
      tabId = Number(created.evidence.tabId);
      assert(tabId > 0);
      await call('page.wait_for_load_state', {
        waitForLoad: true,
        url: origin,
        urlMatch: 'contains',
        timeoutMs: 10000,
      });
      await call('dom.wait_for', { selector: '#board', state: 'visible', timeoutMs: 10000 });
      await settle();

      for (const name of [
        'unchanged',
        'text',
        'css',
        'canvas',
        'remove',
        'subtle',
        'distant',
        'dense',
        'outside',
      ]) {
        await scenario(name, async () => {
          await settle('resetFixture()');
          const baseline = await create();
          const before = await capture(baseline.scope.rect);
          let semanticId: string | undefined;
          if (name === 'css' || name === 'canvas') {
            semanticId = String(
              (
                await call('dom.baseline.create', {
                  selector: '#board',
                  maxNodes: 100,
                  attributeAllowlist: [],
                })
              ).evidence.baselineId
            );
            semanticHandles.add(semanticId);
          }
          await settle(`applyChange(${JSON.stringify(name)})`);
          const response = await call('screenshot.baseline.compare', {
            baselineId: baseline.baselineId,
          });
          const compared = response.evidence as unknown as VisualBaselineCompareResult;
          assert.equal(compared.comparable, true);
          const after = await capture(baseline.scope.rect);
          const blocks = images(response.result);
          const changed = verifyPixels(before.pixels, after.pixels, compared, blocks);
          if (name === 'unchanged' || name === 'outside') {
            assert.equal(changed, 0);
            assert.equal(blocks.length, 0);
          } else if (name === 'distant' || name === 'dense') {
            assert(changed > 0);
            assert.equal(compared.status, 'diff_not_useful');
            assert.equal(
              compared.reason,
              name === 'dense' ? 'too_different' : 'changes_too_spread_out'
            );
            assert.equal(blocks.length, 0);
          } else {
            assert(changed > 0);
            assert.equal(compared.status, 'changed');
            assert.equal(compared.images[0].phase, 'before');
            assert.equal(compared.images[1].phase, 'after');
          }
          if (semanticId) {
            assert.equal(
              (await call('dom.baseline.compare', { baselineId: semanticId })).evidence.equal,
              true,
              `${name} should demonstrate pixels changing while semantic DOM stays equal`
            );
            await call('dom.baseline.release', { baselineId: semanticId });
            semanticHandles.delete(semanticId);
          }
          if (name === 'canvas' || name === 'remove') {
            const element = name === 'canvas' ? 'chart' : 'remove-group';
            const box = record(
              await evaluate(
                `(() => { const r = document.getElementById('${element}').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`
              )
            );
            const sx = before.pixels.width / baseline.scope.rect.width;
            const sy = before.pixels.height / baseline.scope.rect.height;
            const rect = compared.images[1].rect;
            assert(rect.x <= Math.floor((Number(box.x) - baseline.scope.rect.x) * sx));
            assert(rect.y <= Math.floor((Number(box.y) - baseline.scope.rect.y) * sy));
            assert(
              rect.x + rect.width >=
                Math.ceil((Number(box.x) + Number(box.width) - baseline.scope.rect.x) * sx)
            );
            assert(
              rect.y + rect.height >=
                Math.ceil((Number(box.y) + Number(box.height) - baseline.scope.rect.y) * sy)
            );
          }
          await writeFile(path.join(output, `${name}-before.png`), before.bytes);
          await writeFile(path.join(output, `${name}-after.png`), after.bytes);
          for (const [index, block] of blocks.entries())
            await writeFile(
              path.join(output, `${name}-evidence-${index}.png`),
              Buffer.from(block.data, 'base64')
            );
          const evidenceBytes = blocks.reduce(
            (sum, block) => sum + Buffer.from(block.data, 'base64').length,
            0
          );
          rows.push({
            scenario: name,
            passed: true,
            changedPixels: changed,
            status: compared.status,
            reason: compared.reason,
            changedRect: compared.changedRect,
            cropAreaRatio: compared.cropAreaRatio,
            strategy: compared.strategy,
            captureMs: after.ms,
            compareMs: response.ms,
            fullNewPngBytes: after.bytes.length,
            evidencePngBytes: evidenceBytes,
            fullNewImageTokensEstimate: imageTokens(after.pixels.width, after.pixels.height),
            evidenceImageTokensEstimate: compared.images.reduce(
              (sum, image) => sum + imageTokens(image.rect.width, image.rect.height),
              0
            ),
            scope: baseline.scope,
            dimensions: baseline.dimensions,
            evidence: compared.images,
          });
          await release(baseline.baselineId);
        });
      }

      await scenario('fixed reference, explicit advance, after-only and release', async () => {
        await settle('resetFixture()');
        const baseline = await create();
        await settle("applyChange('text')");
        const first = await call('screenshot.baseline.compare', {
          baselineId: baseline.baselineId,
        });
        const repeated = await call('screenshot.baseline.compare', {
          baselineId: baseline.baselineId,
        });
        assert.equal(first.evidence.equal, false);
        assert.equal(first.evidence.changedPixels, repeated.evidence.changedPixels);
        const advanced = await call('screenshot.baseline.compare', {
          baselineId: baseline.baselineId,
          includeBefore: false,
          advance: true,
        });
        assert.equal(advanced.evidence.advanced, true);
        assert.equal(images(advanced.result).length, 1);
        assert.equal(
          (await call('screenshot.baseline.compare', { baselineId: baseline.baselineId })).evidence
            .equal,
          true
        );
        assert.equal((await release(baseline.baselineId)).released, true);
        assert.equal((await release(baseline.baselineId)).released, false);
        assert.equal(
          record(
            (await raw('screenshot.baseline.compare', { baselineId: baseline.baselineId }))
              .structured.error
          ).code,
          'VISUAL_BASELINE_NOT_FOUND'
        );
        rows.push({ scenario: 'reference advance and release', passed: true });
      });

      await scenario(
        'unhelpful diffs preserve the reference and require explicit image fallback',
        async () => {
          await settle('resetFixture()');
          const baseline = await create();
          const before = await capture(baseline.scope.rect);
          await settle("applyChange('distant')");
          const summary = await call('screenshot.baseline.compare', {
            baselineId: baseline.baselineId,
            advance: true,
          });
          assert.equal(summary.evidence.status, 'diff_not_useful');
          assert.equal(summary.evidence.advanced, false);
          assert.equal(images(summary.result).length, 0);
          const current = await call('screenshot.baseline.compare', {
            baselineId: baseline.baselineId,
            fallback: 'current',
            includeBefore: true,
            advance: true,
          });
          assert.equal(current.evidence.status, 'diff_not_useful');
          assert.equal(current.evidence.advanced, true);
          assert.equal(current.evidence.strategy, 'full');
          assert.equal(images(current.result).length, 1);
          const compared = current.evidence as unknown as VisualBaselineCompareResult;
          assert.equal(compared.images[0].phase, 'after');
          const after = await capture(baseline.scope.rect);
          verifyPixels(before.pixels, after.pixels, compared, images(current.result));
          assert.equal(
            (await call('screenshot.baseline.compare', { baselineId: baseline.baselineId }))
              .evidence.status,
            'unchanged'
          );
          await release(baseline.baselineId);
          rows.push({
            scenario: 'explicit current-only fallback',
            passed: true,
            defaultImageCount: 0,
            explicitImageCount: 1,
          });
        }
      );

      await scenario('rect scope rejects misleading scroll comparison', async () => {
        await settle('resetFixture()');
        const scope = await create();
        await release(scope.baselineId);
        const baseline = await create({ rect: scope.scope.rect });
        await settle('window.scrollTo(0, 90)');
        const response = await call('screenshot.baseline.compare', {
          baselineId: baseline.baselineId,
          advance: true,
        });
        assert.equal(response.evidence.comparable, false);
        assert.equal(response.evidence.equal, null);
        assert.equal(response.evidence.requiresNewBaseline, true);
        assert.equal(response.evidence.advanced, false);
        assert.equal(response.evidence.status, 'not_comparable');
        assert.equal(images(response.result).length, 0);
        assert.equal((await release(baseline.baselineId)).released, false);
        await settle('resetFixture()');
        const explicit = await create({ rect: scope.scope.rect });
        await settle('window.scrollTo(0, 90)');
        const current = await call('screenshot.baseline.compare', {
          baselineId: explicit.baselineId,
          fallback: 'current',
        });
        assert.equal(current.evidence.status, 'not_comparable');
        assert.equal(current.evidence.equal, null);
        assert.equal(images(current.result).length, 1);
        await release(explicit.baselineId);
        rows.push({ scenario: 'scroll fallback', passed: true });
      });

      await scenario('selector layout changes require a new reference', async () => {
        await settle('resetFixture()');
        const baseline = await create();
        await settle("applyChange('layout')");
        const compared = await call('screenshot.baseline.compare', {
          baselineId: baseline.baselineId,
        });
        assert.equal(compared.evidence.comparable, false);
        assert.equal(compared.evidence.equal, null);
        assert.equal(compared.evidence.requiresNewBaseline, true);
        assert.equal(images(compared.result).length, 0);
        await release(baseline.baselineId);
        rows.push({ scenario: 'layout fallback', passed: true });
      });

      await scenario('DPR 2 evidence coordinates map to the captured pixels', async () => {
        await call('viewport.resize', { width: 1000, height: 800, deviceScaleFactor: 2 });
        viewportOverridden = true;
        await settle('resetFixture()');
        await stableScene();
        const baseline = await create();
        const before = await capture(baseline.scope.rect);
        await settle("applyChange('text')");
        const response = await call('screenshot.baseline.compare', {
          baselineId: baseline.baselineId,
        });
        const after = await capture(baseline.scope.rect);
        await writeFile(path.join(output, 'dpr2-before.png'), before.bytes);
        await writeFile(path.join(output, 'dpr2-after.png'), after.bytes);
        for (const [index, block] of images(response.result).entries())
          await writeFile(
            path.join(output, `dpr2-evidence-${index}.png`),
            Buffer.from(block.data, 'base64')
          );
        assert.equal(baseline.scope.devicePixelRatio, 2);
        verifyPixels(
          before.pixels,
          after.pixels,
          response.evidence as unknown as VisualBaselineCompareResult,
          images(response.result)
        );
        await release(baseline.baselineId);
        await call('viewport.resize', { reset: true });
        viewportOverridden = false;
        rows.push({
          scenario: 'DPR 2 mapping',
          passed: true,
          dimensions: baseline.dimensions,
          scope: baseline.scope,
        });
      });

      await scenario('normal DOM, styles, input and screenshot workflows still work', async () => {
        await settle('resetFixture()');
        const baseline = await create();
        await call('input.fill', {
          target: { label: 'Email' },
          value: 'live@example.test',
          observe: false,
        });
        await call('input.click', {
          target: { role: 'button', name: 'Save fixture', exact: true },
        });
        const status = await call('dom.get_text', { target: { selector: '#status' } });
        assert(JSON.stringify(status.evidence).includes('Saved fixture'));
        const styles = await call('styles.get_computed', {
          target: { selector: '#color' },
          properties: ['background-color'],
        });
        assert(JSON.stringify(styles.evidence).includes('rgb'));
        const query = await call('dom.query', { selector: '#metric', maxNodes: 5, maxDepth: 2 });
        assert.equal(images(query.result).length, 0);
        const screenshot = await capture(baseline.scope.rect);
        assert(screenshot.pixels.width > 0);
        await release(baseline.baselineId);
        rows.push({ scenario: 'ordinary workflows', passed: true });
      });

      await scenario(
        'opt-in overhead, retained-state overhead and concurrent daemon responsiveness',
        async () => {
          await settle('resetFixture()');
          const scope = await create();
          await release(scope.baselineId);
          const samples: Record<
            string,
            { dom: number[]; screenshot: number[]; compare: number[] }
          > = {};
          for (const mode of ['cold', 'retained', 'released', 'retained-again', 'released-again']) {
            samples[mode] = { dom: [], screenshot: [], compare: [] };
            const baseline = mode.startsWith('retained') ? await create() : undefined;
            for (let run = 0; run < 12; run++) {
              const dom = await call('dom.query', {
                selector: '#metric',
                maxNodes: 5,
                maxDepth: 2,
                textBudget: 80,
              });
              assert.equal(images(dom.result).length, 0);
              const screenshot = await capture(scope.scope.rect);
              if (run >= 2) {
                samples[mode].dom.push(dom.ms);
                samples[mode].screenshot.push(screenshot.ms);
              }
              if (baseline) {
                const compared = await call('screenshot.baseline.compare', {
                  baselineId: baseline.baselineId,
                });
                assert.equal(compared.evidence.equal, true);
                assert.equal(images(compared.result).length, 0);
                if (run >= 2) samples[mode].compare.push(compared.ms);
              }
            }
            if (baseline) await release(baseline.baselineId);
          }
          const baseline = await create();
          await settle("applyChange('distant')");
          const responsiveness: number[] = [];
          for (let i = 0; i < 20; i++) {
            const [comparison, health] = await Promise.all([
              call('screenshot.baseline.compare', { baselineId: baseline.baselineId }),
              call('daemon.metrics'),
            ]);
            assert.equal(comparison.evidence.equal, false);
            assert.equal(comparison.evidence.status, 'diff_not_useful');
            assert.equal(images(comparison.result).length, 0);
            assert(
              typeof health.evidence.pendingRequests === 'number' ||
                (Array.isArray(health.evidence.nodes) &&
                  health.evidence.nodes.includes('pendingRequests')),
              'compact metrics must identify the pending-request field'
            );
            responsiveness.push(health.ms);
          }
          await release(baseline.baselineId);
          const summaries = Object.fromEntries(
            Object.entries(samples).map(([mode, values]) => [
              mode,
              {
                dom: percentiles(values.dom),
                screenshot: percentiles(values.screenshot),
                ...(values.compare.length ? { compare: percentiles(values.compare) } : {}),
              },
            ])
          );
          rows.push({
            scenario: 'opt-in overhead',
            passed: true,
            samples,
            summaries,
            concurrentDaemonMetrics: percentiles(responsiveness),
            note: 'Same implementation, before/during retained baselines/after release; not a pre-feature binary A/B. Timing differences are descriptive, not a statistical non-regression proof.',
          });
        }
      );

      await scenario(
        'quota failures do not poison normal reads and navigation clears references',
        async () => {
          await settle('resetFixture()');
          const first = await create();
          const second = await create();
          const refused = await raw('screenshot.baseline.create', { selector: '#board' });
          assert.equal(refused.result.isError, true);
          assert.equal(record(refused.structured.error).code, 'VISUAL_BASELINE_QUOTA_EXCEEDED');
          await call('dom.query', { selector: '#metric', maxNodes: 5 });
          await call('navigation.reload', { waitForLoad: true, timeoutMs: 10000 });
          await call('dom.wait_for', { selector: '#board', state: 'visible', timeoutMs: 10000 });
          assert.equal((await release(first.baselineId)).released, false);
          assert.equal((await release(second.baselineId)).released, false);
          const fresh = await create();
          await release(fresh.baselineId);
          rows.push({ scenario: 'quota recovery and navigation cleanup', passed: true });
        }
      );
      await scenario('tab closure discards an outstanding reference', async () => {
        await settle('resetFixture()');
        const baseline = await create();
        await call('tabs.close', { tabId });
        tabId = undefined;
        assert.equal((await release(baseline.baselineId)).released, false);
        rows.push({ scenario: 'tab closure cleanup', passed: true });
      });
    } finally {
      const cleanupErrors: string[] = [];
      const cleanup = {
        taskTabClosed: tabId === undefined,
        viewportReset: !viewportOverridden,
        serverClosed: false,
      };
      for (const baselineId of handles) {
        try {
          await call('screenshot.baseline.release', { baselineId });
        } catch (error: unknown) {
          cleanupErrors.push(String(error));
        }
      }
      if (viewportOverridden) {
        try {
          await call('viewport.resize', { reset: true });
          cleanup.viewportReset = true;
        } catch (error: unknown) {
          cleanupErrors.push(String(error));
        }
      }
      if (tabId) {
        try {
          await call('tabs.close', { tabId });
          cleanup.taskTabClosed = true;
        } catch (error: unknown) {
          cleanupErrors.push(String(error));
        }
      }
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      cleanup.serverClosed = true;
      await writeFile(
        path.join(output, 'results.json'),
        JSON.stringify(
          { ...runMetadata, node: process.version, cleanup, cleanupErrors, rows },
          null,
          2
        ) + '\n'
      );
      t.diagnostic(`Evidence and raw timings: ${output}`);
      for (const row of rows)
        t.diagnostic(
          JSON.stringify(row.scenario === 'opt-in overhead' ? { ...row, samples: undefined } : row)
        );
      assert.deepEqual(cleanupErrors, [], 'test-owned resources must be cleaned up');
    }
  }
);

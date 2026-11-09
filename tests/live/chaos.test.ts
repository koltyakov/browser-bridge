import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { eventually, object } from '../_helpers/chromePipe.ts';
import { ChaosHarness, positiveSetting } from './chaos-harness.ts';

// Deliberately absent from make test. Never infer an executable or attach to a
// running browser: the destructive scenarios require this explicit invocation.
test('disposable headed-Chrome fault recovery', { timeout: 1_800_000 }, async (t) => {
  assert.equal(process.platform, 'linux', 'Run on disposable Linux; see tests/live/README.md');
  const executable = process.env.BBX_CHAOS_CHROME;
  assert(
    executable && path.isAbsolute(executable),
    'Set BBX_CHAOS_CHROME to an absolute Chrome for Testing/Chromium executable'
  );
  const recoveryMs = positiveSetting('BBX_CHAOS_RECOVERY_MS', 20_000, 5000, 60_000);
  const rounds = positiveSetting('BBX_CHAOS_ROUNDS', 2, 1, 5);
  const harness = new ChaosHarness();
  let passed = false;
  t.after(async () => {
    let cleanupOk = false;
    try {
      await harness.close();
      cleanupOk = true;
    } finally {
      await mkdir(harness.output, { recursive: true });
      await writeFile(
        path.join(harness.output, 'results.json'),
        JSON.stringify(
          {
            recoveryDeadlineMs: recoveryMs,
            rounds,
            passed,
            cleanupOk,
            measurements: harness.measurements,
          },
          null,
          2
        )
      );
    }
  });
  await harness.start(executable);
  t.diagnostic(`Synthetic fixture logs and measurements: ${harness.output}`);

  async function recoveredSince(faultAt: number) {
    await harness.recover(Math.max(1, recoveryMs - (performance.now() - faultAt)));
    const elapsed = Math.round(performance.now() - faultAt);
    assert(elapsed <= recoveryMs, 'Fault-to-verified-action recovery exceeded deadline');
    return elapsed;
  }

  async function scenario(name: string, run: () => Promise<Record<string, unknown>>) {
    let failed = false;
    await t.test(name, async () => {
      const started = performance.now();
      try {
        const evidence = await run();
        // Check before navigating or closing the fixture so cleanup cannot hide a leak.
        await harness.clean(10_000);
        harness.measurements.push({
          name,
          ok: true,
          elapsedMs: Math.round(performance.now() - started),
          ...evidence,
        });
      } catch (error) {
        failed = true;
        harness.measurements.push({
          name,
          ok: false,
          elapsedMs: Math.round(performance.now() - started),
          error: String(error),
          cause: String((error as Error).cause ?? ''),
        });
        throw error;
      }
    });
    assert(!failed, 'Stop after a failed scenario; inspect its evidence above');
  }

  for (let round = 1; round <= rounds; round++) {
    await scenario(`round ${round}: daemon SIGKILL`, async () => {
      const faultAt = performance.now();
      const pid = await harness.killDaemon();
      // Raw clients never bootstrap a daemon. Recovery must come from Chrome's
      // real native-host reconnect, not a test-side daemon restart.
      const recoveryTimeMs = await recoveredSince(faultAt);
      assert.notEqual(await harness.daemonPid(), pid, 'The daemon must actually be replaced');
      return { fault: 'daemon-kill', oldPid: pid, recoveryTimeMs };
    });

    await scenario(`round ${round}: MV3 worker termination`, async () => {
      const faultAt = performance.now();
      const workerId = await harness.stopWorker();
      const recoveryTimeMs = await recoveredSince(faultAt);
      assert(harness.control);
      const health = await harness.call(harness.control, 'health.ping', { diagnostics: true });
      assert.notEqual(
        object(health.loadedBuild).workerId,
        workerId,
        'The worker must actually restart'
      );
      return { fault: 'worker-stop', recoveryTimeMs };
    });

    await scenario(`round ${round}: caller disconnect during native input sequence`, async () => {
      const owner = await harness.connect();
      const before = await harness.state();
      let settled = false;
      let operationError = '';
      const pending = harness
        .call(
          owner,
          'input.perform',
          {
            timeoutMs: 10_000,
            steps: [
              {
                method: 'input.click',
                params: { target: { selector: '#first' }, executionMode: 'cdp', observe: false },
              },
              {
                method: 'input.click',
                delayMs: 2000,
                params: { target: { selector: '#late' }, executionMode: 'cdp', observe: false },
              },
            ],
          },
          12_000
        )
        .then(
          () => {
            settled = true;
            return 'completed';
          },
          (error: unknown) => {
            operationError = String(error);
            settled = true;
            return 'interrupted';
          }
        );
      await eventually('first native click', 5000, async () => {
        assert.equal(settled, false, `Fault must hit an in-flight operation: ${operationError}`);
        assert.equal((await harness.state()).first, Number(before.first) + 1);
      });
      const faultAt = performance.now();
      await owner.close();
      harness.clients.delete(owner);
      assert.equal(await pending, 'interrupted');
      const recoveryTimeMs = await recoveredSince(faultAt);
      // Remain in the same document past the scheduled second click. A quick
      // successful probe alone would miss abandoned work that resumes later.
      await delay(2300);
      const after = await harness.state();
      assert.equal(after.first, Number(before.first) + 1);
      assert.equal(after.late, before.late, 'Disconnected input resumed after cancellation');
      return { fault: 'input-owner-disconnect', recoveryTimeMs, lateActionSuppressed: true };
    });

    await scenario(
      `round ${round}: caller disconnect during network/activity recording`,
      async () => {
        const owner = await harness.connect();
        const recording = await harness.call(owner, 'session.start', {
          activity: true,
          network: true,
          durationMs: 60_000,
        });
        assert.equal(recording.active, true);
        const status = await harness.call(owner, 'session.status', {
          sessionId: recording.sessionId,
        });
        assert.equal(status.recorderAlive, true, 'Recording must be live before the fault');
        let readSettled = false;
        const pendingRead = harness
          .call(
            owner,
            'session.read',
            {
              sessionId: recording.sessionId,
              cursor: status.nextCursor,
              waitMs: 25_000,
            },
            30_000
          )
          .then(
            () => {
              readSettled = true;
              return 'completed';
            },
            () => {
              readSettled = true;
              return 'interrupted';
            }
          );
        await eventually('recording long poll', 3000, async (remaining) => {
          assert(harness.control);
          const metrics = await harness.call(harness.control, 'daemon.metrics', {}, remaining);
          assert.equal(metrics.pendingRequests, 1);
          assert.equal(readSettled, false, 'Recording read must be pending before disconnect');
        });
        const faultAt = performance.now();
        await owner.close();
        harness.clients.delete(owner);
        assert.equal(await pendingRead, 'interrupted');
        const recoveryTimeMs = await recoveredSince(faultAt);
        await harness.clean(10_000);
        // Reuse the exact tab, without navigation, to prove that the recording
        // registry slot and page recorder can both be acquired and released again.
        assert(harness.control);
        const replacement = await harness.call(harness.control, 'session.start', {
          activity: true,
          network: true,
          durationMs: 60_000,
        });
        assert.notEqual(replacement.sessionId, recording.sessionId);
        assert.equal(replacement.active, true);
        await harness.call(harness.control, 'session.release', {
          sessionId: replacement.sessionId,
        });
        return { fault: 'recording-owner-disconnect', recoveryTimeMs, recordingSlotReused: true };
      }
    );
  }
  passed = true;
});

// @ts-check
import { spawnSync } from 'node:child_process';

const result = spawnSync('gofmt', ['-l', 'cmd', 'internal'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (result.error) {
  process.stderr.write(`Could not run gofmt: ${result.error.message}\n`);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else if (result.stdout.trim()) {
  process.stderr.write(
    `Go files need formatting:\n${result.stdout}\nRun make format-go to fix them.\n`
  );
  process.exitCode = 1;
}

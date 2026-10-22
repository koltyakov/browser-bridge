// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = resolveVersion({ root });
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
const supported = ['darwin-arm64', 'darwin-amd64', 'linux-arm64', 'linux-amd64', 'windows-amd64'];
const targets = process.argv.includes('--all')
  ? supported
  : [process.argv[2] ?? `${platform}-${architecture}`];
for (const target of targets) {
  if (!supported.includes(target)) throw new Error(`Unsupported native target: ${target}`);
}

// Generated files are checked in so ordinary Go builds need no Node runtime.
execFileSync(process.execPath, ['scripts/generate-protocol.mjs', '--check'], {
  cwd: root,
  stdio: 'inherit',
});
await fs.mkdir(path.join(root, 'dist/cli'), { recursive: true });
for (const target of targets) {
  const [goos, goarch] = target.split('-');
  const asset = `bbx-${target.replace('amd64', 'x64')}${goos === 'windows' ? '.exe' : ''}`;
  const output = path.join(root, 'dist/cli', asset);
  execFileSync(
    'go',
    [
      'build',
      '-trimpath',
      '-buildvcs=false',
      // Inlining trades executable size for call-site speed. This I/O-oriented
      // runtime keeps the full implementation under the native payload budget.
      '-gcflags=all=-l',
      '-ldflags',
      `-s -w -X github.com/koltyakov/browser-bridge/internal/bridge.version=${version} -X github.com/koltyakov/browser-bridge/internal/bridge.buildTarget=go-${target}`,
      '-o',
      output,
      './cmd/bbx',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: goos,
        GOARCH: goarch,
        GOAMD64: 'v1',
        GOARM64: 'v8.0',
      },
      stdio: 'inherit',
    }
  );
  const bytes = (await fs.stat(output)).size;
  if (bytes >= 10_000_000)
    throw new Error(`${asset}: ${bytes} bytes exceeds the 10 MB native executable budget`);
  console.log(`${asset}: ${(bytes / 1e6).toFixed(2)} MB (${bytes} bytes)`);
}

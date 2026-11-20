import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

interface FixtureRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string; size: number }[];
}

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const available = await Promise.all(
  ['go', 'openssl'].map((command) =>
    exec(command, ['version']).then(
      () => true,
      () => false
    )
  )
);

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function initialize(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      if (!output.includes('\n')) return;
      try {
        const response = JSON.parse(output.split('\n')[0]) as {
          result: { serverInfo: { version: string } };
        };
        resolve(response.result.serverInfo.version);
      } catch (error) {
        reject(error);
      }
    });
    child.once('error', reject);
    child.once('exit', () => reject(new Error('MCP exited before initialization')));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'update-lifecycle-test', version: '1' },
        },
      }) + '\n'
    );
  });
}

test(
  'extension upgrade discovers its newest GitHub release line and replaces native/MCP processes without a feed',
  // Go uses the Windows system certificate store rather than SSL_CERT_FILE.
  { skip: process.platform === 'win32' || !available.every(Boolean), timeout: 120_000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-update-lifecycle-'));
    const home = path.join(directory, 'home');
    const children: ChildProcessWithoutNullStreams[] = [];
    const responses = new Map<string, Buffer>();
    let server: https.Server | undefined;
    t.after(async () => {
      for (const child of children) {
        child.stdin.end();
        if (child.exitCode === null) child.kill();
      }
      try {
        const pid = Number(await fs.readFile(path.join(home, 'daemon.pid'), 'utf8'));
        if (pid > 1 && pid !== process.pid) process.kill(pid, 'SIGTERM');
      } catch {
        // The isolated daemon may already have stopped.
      }
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    });
    await fs.mkdir(home);
    const cert = path.join(directory, 'cert.pem');
    const keyFile = path.join(directory, 'key.pem');
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    server = https.createServer(
      { key: await fs.readFile(keyFile), cert: await fs.readFile(cert) },
      (request, response) => {
        const body = responses.get(request.url || '');
        response.writeHead(body ? 200 : 404);
        response.end(body || 'missing');
      }
    );
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const url = `https://127.0.0.1:${address.port}`;
    // Fixture endpoints are compiled into these temporary test executables.
    // Production URLs cannot be replaced by environment or runtime settings.
    const packagePath = 'github.com/koltyakov/browser-bridge/internal/bridge';
    const flags = `-X ${packagePath}.nativeUpdateGitHubAPI=${url}/repos/koltyakov/browser-bridge -X ${packagePath}.nativeUpdateGitHubDownloads=${url}/releases/download`;
    const target = `go-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
    const binaries: Record<string, string> = {};
    const releases: FixtureRelease[] = [];
    const assetName = `bbx-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
    for (const version of ['2.2.1', '2.3.2']) {
      const binary = path.join(
        directory,
        `bbx-${version}${process.platform === 'win32' ? '.exe' : ''}`
      );
      await exec(
        'go',
        [
          'build',
          '-tags=nethttpomithttp2,purego',
          '-gcflags=all=-l',
          '-ldflags',
          `-s -w -funcalign=8 ${flags} -X github.com/koltyakov/browser-bridge/internal/bridge.version=${version} -X github.com/koltyakov/browser-bridge/internal/bridge.buildTarget=${target}`,
          '-o',
          binary,
          './cmd/bbx',
        ],
        { cwd: root, env: { ...process.env, CGO_ENABLED: '0' } }
      );
      const bytes = await fs.readFile(binary);
      binaries[version] = binary;
      const base = `/releases/download/v${version}`;
      const checksums = Buffer.from(
        `${createHash('sha256').update(bytes).digest('hex')}  ${assetName}\n`
      );
      responses.set(`${base}/${assetName}`, bytes);
      responses.set(`${base}/checksums.txt`, checksums);
      releases.push({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: [
          {
            name: assetName,
            browser_download_url: `${url}${base}/${assetName}`,
            size: bytes.length,
          },
          {
            name: 'checksums.txt',
            browser_download_url: `${url}${base}/checksums.txt`,
            size: checksums.length,
          },
        ],
      });
    }
    // An outside-line release must never be selected or probed.
    releases.push({ ...releases[1], tag_name: 'v2.4.9' });
    responses.set(
      '/repos/koltyakov/browser-bridge/releases?per_page=100&page=1',
      Buffer.from(JSON.stringify(releases))
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BROWSER_BRIDGE_HOME: home,
      BBX_AUTO_UPDATE: 'compatible',
      BBX_NPM_VERSION: '2.2.1',
      HOME: path.join(directory, 'user'),
      XDG_CONFIG_HOME: path.join(directory, 'user-config'),
      BBX_REMOTE: '',
      SSL_CERT_FILE: cert,
      BBX_TCP_PORT: String(await unusedPort()),
      BBX_TCP_HOST: '127.0.0.1',
      BBX_TCP_BIND_HOST: '127.0.0.1',
    };
    const start = (args: string[]) => {
      const child = spawn(binaries['2.2.1'], args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      child.stderr.on('data', (bytes: Buffer) => t.diagnostic(bytes.toString()));
      return child;
    };
    start(['--bridge-daemon']).stdout.resume();
    await waitFor('initial daemon', () =>
      fs.stat(path.join(home, 'daemon.pid')).then(
        () => true,
        () => false
      )
    );
    const mcp = start(['mcp', 'serve']);
    assert.equal(await initialize(mcp), '2.2.1');
    const oldPid = await fs.readFile(path.join(home, 'daemon.pid'), 'utf8');
    const host = start(['--native-host']);
    host.stdout.resume();
    const message = Buffer.from(
      JSON.stringify({
        type: 'host.identity',
        extensionVersion: '2.3.0',
        supported_versions: ['2.3'],
        browserName: 'fixture',
        profileLabel: 'isolated-test',
      })
    );
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(message.length);
    host.stdin.write(Buffer.concat([prefix, message]));
    try {
      await waitFor('native/MCP replacement', async () => {
        try {
          return (
            (await fs.readFile(path.join(home, 'daemon.pid'), 'utf8')) !== oldPid &&
            mcp.exitCode !== null &&
            host.exitCode !== null
          );
        } catch {
          return false;
        }
      });
    } catch (error) {
      t.diagnostic(
        await fs
          .readFile(path.join(home, 'native-update/state.json'), 'utf8')
          .catch(() => 'No update state')
      );
      t.diagnostic(
        await fs.readFile(path.join(home, 'daemon.log'), 'utf8').catch(() => 'No daemon log')
      );
      t.diagnostic(JSON.stringify({ oldPid, mcpExit: mcp.exitCode, hostExit: host.exitCode }));
      throw error;
    }
    assert.equal(await initialize(start(['mcp', 'serve'])), '2.3.2');
    const status = JSON.parse(
      (await exec(binaries['2.2.1'], ['update', 'status'], { env })).stdout
    ) as {
      version: string;
      verified: boolean;
      source: string;
    };
    assert.equal(status.version, '2.3.2');
    assert.equal(status.verified, true);
    assert.equal(status.source, 'github');
  }
);

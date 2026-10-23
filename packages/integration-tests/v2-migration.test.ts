import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { bridgeServerWith } from '../../tests/_helpers/socketHarness.ts';
import { createSuccess } from '../protocol/src/index.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));

async function run(entry: string, args: string[], stdin: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
    child.stdin.end(stdin);
  });
  return { status, stdout, stderr };
}

test(
  'Node 1.15 hands CLI and MCP startup to the new npm layout without consuming stdin',
  { timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bbx-v2-migration-'));
    const globalRoot = path.join(root, 'global');
    const packageRoot = path.join(globalRoot, '@browserbridge/bbx');
    const server = await bridgeServerWith({
      'health.ping': (request) =>
        createSuccess(request.id, {
          daemonVersion: '1.15.0',
          extensionConnected: true,
          extensionVersion: '2.0.0',
          supported_versions: ['2.0', '1.15'],
          extension_supported_versions: ['2.0'],
        }),
      'page.evaluate': (request) =>
        createSuccess(request.id, { type: 'string', value: 'Still on Node' }),
    });
    try {
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.cp(path.join(repository, 'packages'), path.join(packageRoot, 'packages'), {
        recursive: true,
        filter: (source) => path.basename(source) !== 'test',
      });
      await fs.symlink(
        path.join(repository, 'node_modules'),
        path.join(packageRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const manifestPath = path.join(packageRoot, 'package.json');
      const npm = path.join(root, 'npm.mjs');
      const updatedEntry = 'packages/npm/bin/bbx.js';
      await fs.mkdir(path.dirname(path.join(packageRoot, updatedEntry)), { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, updatedEntry),
        `
      let input='';
      for await (const chunk of process.stdin) input+=chunk;
      console.log(JSON.stringify({args:process.argv.slice(2),input,policy:process.env.BBX_AUTO_UPDATE}));
    `
      );
      await fs.writeFile(
        npm,
        `
      import fs from 'node:fs';
      const action=process.argv[2];
      if(action==='root') console.log(${JSON.stringify(globalRoot)});
      else if(action==='view') {
        if(process.env.BBX_TEST_REGISTRY_FAILURE) throw Error('Registry unavailable');
        console.log(JSON.stringify(['1.15.0','2.0.0','3.0.0']));
      }
      else if(action==='install') {
        if(process.argv.at(-1)!=='@browserbridge/bbx@2.0.0') throw Error('Wrong release');
        fs.writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify({type:'module',version:'2.0.0',bin:{bbx:${JSON.stringify(updatedEntry)},'bbx-mcp':${JSON.stringify(updatedEntry)}}}));
      } else throw Error('Unexpected npm command');
    `
      );
      const env = {
        ...process.env,
        BROWSER_BRIDGE_HOME: server.bridgeHome,
        BBX_TCP_PORT: '',
        BBX_REMOTE: '',
        BBX_AUTH_TOKEN: undefined,
        BBX_AUTO_UPDATE: undefined,
        npm_execpath: npm,
      };
      for (const mode of ['cli', 'mcp', 'cli-mcp']) {
        await fs.writeFile(
          manifestPath,
          JSON.stringify({
            type: 'module',
            name: '@browserbridge/bbx',
            version: '1.15.0',
            bin: {
              bbx: 'packages/agent-client/src/cli.js',
              'bbx-mcp': 'packages/mcp-server/src/bin.js',
            },
          })
        );
        const args = mode === 'cli' ? ['eval', '-'] : mode === 'cli-mcp' ? ['mcp', 'serve'] : [];
        const entry = path.join(
          packageRoot,
          mode === 'mcp' ? 'packages/mcp-server/src/bin.js' : 'packages/agent-client/src/cli.js'
        );
        const input =
          mode === 'cli'
            ? 'document.title'
            : '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n';
        const result = await run(entry, args, input, env);
        assert.equal(result.status, 0, result.stderr);
        assert.notEqual(
          result.stdout.trim(),
          '',
          JSON.stringify({
            mode,
            ...result,
            manifest: JSON.parse(await fs.readFile(manifestPath, 'utf8')),
            requests: server.requests,
          })
        );
        assert.deepEqual(JSON.parse(result.stdout), { args, input, policy: 'off' });
      }
      assert.deepEqual(
        server.requests.map((request) => request.method),
        ['health.ping', 'health.ping', 'health.ping']
      );
      assert.equal(
        server.requests.every((request) => request.meta.protocol_version === '2.0'),
        true
      );
      for (const mode of ['environment-off', 'persisted-off', 'registry-failure']) {
        await fs.writeFile(
          manifestPath,
          JSON.stringify({
            type: 'module',
            name: '@browserbridge/bbx',
            version: '1.15.0',
            bin: { bbx: 'packages/agent-client/src/cli.js' },
          })
        );
        await fs.writeFile(
          path.join(server.bridgeHome, 'config.json'),
          JSON.stringify(mode === 'persisted-off' ? { autoUpdate: 'off' } : {})
        );
        const before = server.requests.length;
        const result = await run(
          path.join(packageRoot, 'packages/agent-client/src/cli.js'),
          ['eval', '-'],
          'document.title',
          {
            ...env,
            BBX_AUTO_UPDATE: mode === 'environment-off' ? 'off' : undefined,
            BBX_TEST_REGISTRY_FAILURE: mode === 'registry-failure' ? '1' : undefined,
          }
        );
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Still on Node/);
        assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).version, '1.15.0');
        assert.deepEqual(
          server.requests.slice(before).map((request) => request.method),
          mode === 'registry-failure' ? ['health.ping', 'page.evaluate'] : ['page.evaluate']
        );
      }
    } finally {
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);

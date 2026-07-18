// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { getBridgeAuthTokenPath } from '../../native-host/src/auth-token.js';
import {
  createTcpBridgeTransport,
  getProxyConfigPath,
  readProxyConfig,
} from '../../native-host/src/config.js';
import { pingExistingDaemon } from '../../native-host/src/daemon.js';
import { restartBridgeDaemon } from '../../native-host/src/daemon-process.js';
import { atomicWriteFile } from './atomic-write.js';
import { parseIntArg } from './cli-helpers.js';
import {
  addRemoteDestination,
  assertProxyBindSafety,
  createBridgeClientForDestination,
  isLoopbackHost,
  listBridgeDestinations,
  normalizeDestinationId,
  parseRemoteEndpoint,
  readRemoteConfig,
  removeRemoteDestination,
  resolveProxyEnableSettings,
} from './remotes.js';

/**
 * Handle `bbx proxy <enable|disable|status>`.
 *
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export async function handleProxyCommand(args) {
  const [subcommand, ...restArgs] = args;
  if (subcommand === 'enable') {
    const options = parseProxyEnableArgs(restArgs);
    const existing = readProxyConfig();
    const { port, bindHost, token, tokenSource } = resolveProxyEnableSettings(
      existing,
      options,
      randomUUID
    );
    assertProxyBindSafety(existing, options, bindHost);
    await atomicWriteFile(getBridgeAuthTokenPath(), `${token}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const configPath = getProxyConfigPath();
    await atomicWriteFile(
      configPath,
      `${JSON.stringify(
        {
          enabled: true,
          port,
          bindHost,
          token,
        },
        null,
        2
      )}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    const result = await restartBridgeDaemon();
    const tokenNote =
      tokenSource === 'existing'
        ? ' (unchanged - already-configured clients keep working; pass --rotate-token to generate a new secret)'
        : tokenSource === 'generated' && existing
          ? ' (rotated - update every configured client with `bbx remote add`)'
          : '';
    const lines = [
      `Browser Bridge proxy enabled on ${bindHost}:${port}.`,
      '',
      `Token: ${token}${tokenNote}`,
      `Config: ${configPath}`,
      `Daemon: ${result.previouslyRunning ? 'restarted' : 'started'} (pid ${result.pid})`,
    ];
    if (tokenSource !== 'existing') {
      if (isLoopbackHost(bindHost)) {
        lines.push(
          '',
          'On your dev machine, open an SSH local-forward:',
          '',
          `ssh -N -L ${port}:127.0.0.1:${port} <user>@<browser-host>`,
          '',
          'Save the token to a private file, then add the tunneled remote:',
          '',
          `bbx remote add remote-bbx 127.0.0.1:${port} --token-file <token-file>`
        );
      } else {
        lines.push(
          '',
          'WARNING: raw TCP is exposed without transport encryption.',
          'On your dev machine, add this direct remote:',
          '',
          `bbx remote add remote-bbx ${getProxyExampleHost(bindHost)}:${port} --token-file <token-file>`
        );
      }
    }
    lines.push('');
    process.stdout.write(lines.join('\n'));
    return;
  }

  if (subcommand === 'disable') {
    const configPath = getProxyConfigPath();
    await fs.promises.rm(configPath, { force: true });
    const result = await restartBridgeDaemon();
    process.stdout.write(
      `Browser Bridge proxy disabled. Daemon ${result.previouslyRunning ? 'restarted' : 'started'}.\n`
    );
    return;
  }

  if (subcommand === 'status') {
    const config = readProxyConfig();
    if (!config) {
      process.stdout.write('Browser Bridge proxy is disabled.\n');
      return;
    }
    const reachable = await pingExistingDaemon(createTcpBridgeTransport(config.port, '127.0.0.1'));
    process.stdout.write(
      [
        `Browser Bridge proxy is enabled on ${config.bindHost}:${config.port}.`,
        `Config: ${getProxyConfigPath()}`,
        `Daemon: ${reachable ? 'reachable' : 'not reachable'} on 127.0.0.1:${config.port}`,
        '',
      ].join('\n')
    );
    return;
  }

  throw new Error('Usage: bbx proxy <enable|disable|status>');
}

/**
 * Parse `bbx proxy enable` flags. Values stay undefined when not passed so an
 * existing proxy config can be reused instead of silently reset to defaults.
 *
 * @param {string[]} args
 * @returns {import('./remotes.js').ProxyEnableOptions}
 */
function parseProxyEnableArgs(args) {
  /** @type {import('./remotes.js').ProxyEnableOptions} */
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') {
      options.port = parseIntArg(args[++index] || '', 'port');
      continue;
    }
    if (arg === '--bind-host') {
      options.bindHost = args[++index] || '';
      if (!options.bindHost.trim()) {
        throw new Error('--bind-host requires a value.');
      }
      continue;
    }
    if (arg === '--token') {
      options.token = args[++index] || '';
      if (!options.token.trim()) {
        throw new Error('--token requires a value.');
      }
      continue;
    }
    if (arg === '--rotate-token') {
      options.rotateToken = true;
      continue;
    }
    if (arg === '--unsafe-plaintext') {
      options.unsafePlaintext = true;
      continue;
    }
    throw new Error(`Unknown proxy enable option "${arg}".`);
  }
  if (options.token && options.rotateToken) {
    throw new Error('Use either --token or --rotate-token, not both.');
  }
  if (options.port !== undefined && (options.port < 1 || options.port > 65535)) {
    throw new Error('port must be an integer between 1 and 65535.');
  }
  return options;
}

/**
 * @param {string} bindHost
 * @returns {string}
 */
function getProxyExampleHost(bindHost) {
  if (bindHost !== '0.0.0.0' && bindHost !== '::') {
    return bindHost;
  }

  /** @type {string | null} */
  let firstIpv4 = null;
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') {
        if (name.toLowerCase() === 'ethernet 0') {
          return entry.address;
        }
        firstIpv4 ??= entry.address;
      }
    }
  }

  return firstIpv4 ?? '<host>';
}

/**
 * Handle `bbx remote <add|remove|list|test|destinations>`.
 *
 * @param {string[]} args
 * @returns {Promise<void>}
 */
export async function handleRemoteCommand(args) {
  const [subcommand, ...restArgs] = args;
  if (subcommand === 'add') {
    const [name, endpoint, ...optionArgs] = restArgs;
    if (!name || !endpoint) {
      throw new Error(
        'Usage: bbx remote add <name> <host:port> (--token <token>|--token-file <path>)'
      );
    }
    const token = await parseRemoteTokenOption(optionArgs);
    const { host, port } = parseRemoteEndpoint(endpoint);
    const remote = await addRemoteDestination({
      id: normalizeDestinationId(name),
      host,
      port,
      token,
    });
    process.stdout.write(
      `Remote destination "${remote.id}" saved (${remote.host}:${remote.port}).\n`
    );
    return;
  }

  if (subcommand === 'remove') {
    const [name] = restArgs;
    if (!name) {
      throw new Error('Usage: bbx remote remove <name>');
    }
    const removed = await removeRemoteDestination(name);
    process.stdout.write(
      removed
        ? `Remote destination "${name}" removed.\n`
        : `Remote destination "${name}" was not configured.\n`
    );
    return;
  }

  if (subcommand === 'list') {
    const config = await readRemoteConfig();
    if (config.remotes.length === 0) {
      process.stdout.write('No remote destinations configured.\n');
      return;
    }
    process.stdout.write(
      `${config.remotes.map((remote) => `${remote.id}\t${remote.host}:${remote.port}`).join('\n')}\n`
    );
    return;
  }

  if (subcommand === 'test') {
    const [name] = restArgs;
    if (!name) {
      throw new Error('Usage: bbx remote test <name>');
    }
    const remoteClient = await createBridgeClientForDestination(name);
    try {
      await remoteClient.connect();
      const response = await remoteClient.request({ method: 'health.ping' });
      if (response.ok) {
        const health = /** @type {{ extensionConnected?: boolean }} */ (response.result);
        process.stdout.write(
          `Remote destination "${name}" is reachable (extension ${
            health.extensionConnected === true ? 'connected' : 'not connected'
          }).\n`
        );
      } else {
        process.exitCode = 1;
        process.stdout.write(`Remote destination "${name}" failed: ${response.error.message}\n`);
      }
    } catch (error) {
      process.exitCode = 1;
      process.stdout.write(
        `Remote destination "${name}" is not reachable: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    } finally {
      await remoteClient.close();
    }
    return;
  }

  if (subcommand === 'destinations') {
    const destinations = await listBridgeDestinations();
    process.stdout.write(
      `${destinations
        .map((destination) =>
          destination.local
            ? `${destination.id}\tlocal`
            : `${destination.id}\t${destination.host}:${destination.port}`
        )
        .join('\n')}\n`
    );
    return;
  }

  throw new Error('Usage: bbx remote <add|remove|list|test|destinations>');
}

/**
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function parseRemoteTokenOption(args) {
  let token = '';
  let tokenFile = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--token') {
      const value = args[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('--token requires a value.');
      }
      token = value;
      continue;
    }
    if (arg === '--token-file') {
      const value = args[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('--token-file requires a path.');
      }
      tokenFile = value;
      continue;
    }
    throw new Error(`Unknown remote add option "${arg}".`);
  }
  if ((token && tokenFile) || (!token.trim() && !tokenFile.trim())) {
    throw new Error(
      'Usage: bbx remote add <name> <host:port> (--token <token>|--token-file <path>)'
    );
  }
  return tokenFile ? (await fs.promises.readFile(tokenFile, 'utf8')).trim() : token.trim();
}

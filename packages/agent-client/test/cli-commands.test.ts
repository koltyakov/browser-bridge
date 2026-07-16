import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFailure, createSuccess, PROTOCOL_VERSION } from '../../protocol/src/index.js';
import { PUBLISHED_EXTENSION_ID } from '../../native-host/src/config.js';
import { stopBridgeDaemon } from '../../native-host/src/daemon-process.js';
import { startMcpProcessControl } from '../../mcp-server/src/lifecycle.js';
import { runCli } from '../../../tests/_helpers/runCli.ts';
import { createInstallFs } from '../../../tests/_helpers/installFs.ts';
import { bridgeServerWith } from '../../../tests/_helpers/socketHarness.ts';

type InstallFs = Awaited<ReturnType<typeof createInstallFs>>;
type BrowserManifestKey = keyof InstallFs['browserManifests'];
type CliPayload = {
  ok: boolean;
  summary: string;
  evidence: Record<string, unknown> & {
    browserManifests: { installed: boolean }[];
    issues: string[];
    socketPath: string;
    pidPath: string;
    previouslyRunning: boolean;
    pid: number;
  };
};

function expectCliPayload(value: unknown): CliPayload {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as CliPayload;
}

function escapeSingleQuotedShellValue(value: string): string {
  return value.replaceAll("'", "'\\''");
}

async function seedNativeHostLauncher(installFs: InstallFs): Promise<void> {
  const hostPath = path.join(installFs.root, 'native-host.js');
  await fs.promises.writeFile(hostPath, '#!/usr/bin/env node\n', 'utf8');
  const launcher =
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${hostPath}" %*\r\n`
      : `#!/bin/sh\nexec '${escapeSingleQuotedShellValue(process.execPath)}' '${escapeSingleQuotedShellValue(hostPath)}' "$@"\n`;
  await fs.promises.mkdir(path.dirname(installFs.launcherPath), { recursive: true });
  await fs.promises.writeFile(installFs.launcherPath, launcher, 'utf8');
  if (process.platform !== 'win32') {
    await fs.promises.chmod(installFs.launcherPath, 0o755);
  }
}

async function seedInstalledBrowserManifests(installFs: InstallFs): Promise<void> {
  await Promise.all(
    (Object.keys(installFs.browserManifests) as BrowserManifestKey[]).map((browser) =>
      seedInstalledBrowserManifest(installFs, browser)
    )
  );
}

async function seedInstalledBrowserManifest(
  installFs: InstallFs,
  browser: BrowserManifestKey
): Promise<void> {
  await seedNativeHostLauncher(installFs);
  const manifest = `${JSON.stringify(
    {
      name: 'com.browserbridge.browser_bridge',
      path: installFs.launcherPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${PUBLISHED_EXTENSION_ID}/`],
    },
    null,
    2
  )}\n`;

  const { installDir, manifestPath } = installFs.browserManifests[browser];
  await fs.promises.mkdir(installDir, { recursive: true });
  await fs.promises.writeFile(manifestPath, manifest, 'utf8');
}

test('bbx doctor reports ready when manifests exist and the bridge is fully connected', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-doctor-ready-' });
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) =>
      createSuccess(request.id, {
        daemon: 'ok',
        extensionConnected: true,
        access: {
          enabled: true,
          windowId: 5,
          routeTabId: 12,
          routeReady: true,
          reason: 'ok',
        },
      }),
  });

  try {
    await seedInstalledBrowserManifests(installFs);

    const result = await runCli({
      args: ['doctor'],
      env: {
        ...installFs.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Browser Bridge is ready.');
    assert.equal(payload.evidence.manifestInstalled, true);
    assert.equal(payload.evidence.daemonReachable, true);
    assert.equal(payload.evidence.extensionConnected, true);
    assert.equal(payload.evidence.accessEnabled, true);
    assert.equal(payload.evidence.routeReady, true);
    assert.deepEqual(payload.evidence.issues, []);
    assert.equal(
      payload.evidence.browserManifests.length,
      Object.keys(installFs.browserManifests).length
    );
    assert.equal(bridgeServer.requests.length >= 1, true);
    assert.equal(
      bridgeServer.requests.every((request) => request.method === 'health.ping'),
      true
    );
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
    await installFs.cleanup();
  }
});

test('bbx doctor reports ready when only one browser manifest exists', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-doctor-one-browser-' });
  const bridgeServer = await bridgeServerWith({
    'health.ping': (request) =>
      createSuccess(request.id, {
        daemon: 'ok',
        extensionConnected: true,
        access: {
          enabled: true,
          windowId: 5,
          routeTabId: 12,
          routeReady: true,
          reason: 'ok',
        },
      }),
  });

  try {
    await seedInstalledBrowserManifest(installFs, 'edge');

    const result = await runCli({
      args: ['doctor'],
      env: {
        ...installFs.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Browser Bridge is ready.');
    assert.equal(payload.evidence.manifestInstalled, true);
    assert.deepEqual(payload.evidence.issues, []);
    assert.equal(payload.evidence.browserManifests.filter((entry) => entry.installed).length, 1);
  } finally {
    await bridgeServer.close();
    await installFs.cleanup();
  }
});

test('bbx doctor reports readiness issues when the manifest and daemon are missing', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-doctor-issues-' });

  try {
    const result = await runCli({
      args: ['doctor'],
      env: installFs.env,
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.summary, 'Browser Bridge has 2 readiness issue(s).');
    assert.equal(payload.evidence.manifestInstalled, false);
    assert.equal(payload.evidence.daemonReachable, false);
    assert.deepEqual(payload.evidence.issues, ['native_host_manifest_missing', 'daemon_offline']);
    assert.equal(
      payload.evidence.browserManifests.length,
      Object.keys(installFs.browserManifests).length
    );
    assert.ok(
      payload.evidence.browserManifests.every(
        (entry: { installed: boolean }) => entry.installed === false
      )
    );
  } finally {
    await installFs.cleanup();
  }
});

test('bbx access-request forwards to the bridge and prints a summarized success payload', async () => {
  const bridgeServer = await bridgeServerWith({
    'access.request': (request) =>
      createSuccess(request.id, {
        enabled: false,
        requested: true,
        windowId: 7,
      }),
  });

  try {
    const result = await runCli({
      args: ['access-request'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Bridge method succeeded with 3 top-level fields\./);
    assert.deepEqual(payload.evidence, ['enabled', 'requested', 'windowId']);
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'access.request');
    assert.deepEqual(bridgeServer.requests[1].params, {});
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx summarized bridge failures set a failing exit code', async () => {
  const bridgeServer = await bridgeServerWith({
    'access.request': (request) =>
      createFailure(request.id, 'ACCESS_DENIED', 'Window access was denied.'),
  });

  try {
    const result = await runCli({
      args: ['access-request'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.match(payload.summary, /ACCESS_DENIED: Window access was denied\./);
    assert.equal(bridgeServer.requests[1].method, 'access.request');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx restart starts the daemon when it is offline', async () => {
  const bridgeHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bbx-cli-restart-'));
  let mcpControl: Awaited<ReturnType<typeof startMcpProcessControl>> | null = null;

  try {
    const result = await runCli({
      args: ['restart'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Browser Bridge daemon started.');
    assert.equal(typeof payload.evidence.socketPath, 'string');
    assert.equal(typeof payload.evidence.pidPath, 'string');
    assert.equal(payload.evidence.previouslyRunning, false);
    assert.equal(typeof payload.evidence.pid, 'number');

    mcpControl = await startMcpProcessControl({
      registryDir: path.join(bridgeHome, 'mcp-processes'),
      onRestart: () => {},
    });

    const stopResult = await runCli({
      args: ['restart'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      },
    });
    const stopPayload = expectCliPayload(stopResult.json);
    assert.equal(stopResult.status, 0);
    assert.equal(stopPayload.ok, true);
    assert.equal(
      stopPayload.summary,
      'Browser Bridge daemon restarted. Restart requested for 1 MCP server(s).'
    );
    assert.equal(stopPayload.evidence.previouslyRunning, true);
    assert.deepEqual(stopPayload.evidence.mcpProcesses, {
      registered: 1,
      restartRequested: 1,
      restartFailed: 0,
      staleRegistrationsRemoved: 0,
    });

    await fs.promises.writeFile(
      path.join(bridgeHome, 'mcp-processes', 'unreachable.json'),
      `${JSON.stringify({
        protocolVersion: 1,
        instanceId: 'unreachable',
        pid: process.pid,
        port: 1,
        token: 'not-listening',
      })}\n`,
      'utf8'
    );
    const failedResult = await runCli({
      args: ['restart'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeHome,
      },
    });
    const failedPayload = expectCliPayload(failedResult.json);
    assert.equal(failedResult.status, 1);
    assert.equal(failedPayload.ok, false);
    assert.match(failedPayload.summary, /Could not contact 1 MCP server/);
  } finally {
    await mcpControl?.dispose();
    await stopBridgeDaemon({
      socketPath: path.join(bridgeHome, 'bridge.sock'),
      pidPath: path.join(bridgeHome, 'daemon.pid'),
    });
    await fs.promises.rm(bridgeHome, { recursive: true, force: true });
  }
});

test('bbx logs forwards to log.tail and summarizes returned entries', async () => {
  const bridgeServer = await bridgeServerWith({
    'log.tail': (request) =>
      createSuccess(request.id, {
        entries: [
          {
            at: '2026-05-02T12:34:56.000Z',
            method: 'tabs.list',
            ok: true,
            source: 'cli',
          },
        ],
      }),
  });

  try {
    const result = await runCli({
      args: ['logs'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Log: 1 entries\./);
    assert.deepEqual(payload.evidence, [
      {
        at: '2026-05-02T12:34:56.000Z',
        method: 'tabs.list',
        ok: true,
        source: 'cli',
      },
    ]);
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'log.tail');
    assert.deepEqual(bridgeServer.requests[1].params, { limit: 20 });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tabs forwards to tabs.list and includes tab titles in evidence', async () => {
  const bridgeServer = await bridgeServerWith({
    'tabs.list': (request) =>
      createSuccess(request.id, {
        tabs: [
          {
            tabId: 9,
            active: true,
            origin: 'https://example.com',
            title: 'Example Tab',
          },
        ],
      }),
  });

  try {
    const result = await runCli({
      args: ['tabs'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Bridge listed 1 tab\(s\)\./);
    assert.deepEqual(payload.evidence, [
      {
        tabId: 9,
        active: true,
        origin: 'https://example.com',
        title: 'Example Tab',
      },
    ]);
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'tabs.list');
    assert.deepEqual(bridgeServer.requests[1].params, {});
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tab-create sends the provided URL and prints the created tab summary', async () => {
  const bridgeServer = await bridgeServerWith({
    'tabs.create': (request) =>
      createSuccess(request.id, {
        tabId: 14,
        url: 'https://example.com/docs',
      }),
  });

  try {
    const result = await runCli({
      args: ['tab-create', 'https://example.com/docs'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Tab 14 created \(https:\/\/example\.com\/docs\)\./);
    assert.deepEqual(payload.evidence, {
      tabId: 14,
      url: 'https://example.com/docs',
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'tabs.create');
    assert.deepEqual(bridgeServer.requests[1].params, {
      url: 'https://example.com/docs',
      active: true,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tab-create without a URL falls back to about:blank in the normalized request', async () => {
  const bridgeServer = await bridgeServerWith({
    'tabs.create': (request) =>
      createSuccess(request.id, {
        tabId: 21,
        url: 'about:blank',
      }),
  });

  try {
    const result = await runCli({
      args: ['tab-create'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Tab 21 created \(about:blank\)\./);
    assert.deepEqual(payload.evidence, {
      tabId: 21,
      url: 'about:blank',
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'tabs.create');
    assert.deepEqual(bridgeServer.requests[1].params, {
      url: 'about:blank',
      active: true,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tab-close forwards the parsed numeric tabId to tabs.close', async () => {
  const bridgeServer = await bridgeServerWith({
    'tabs.close': (request) =>
      createSuccess(request.id, {
        closed: true,
        tabId: 42,
      }),
  });

  try {
    const result = await runCli({
      args: ['tab-close', '42'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Tab 42 closed\./);
    assert.deepEqual(payload.evidence, {
      closed: true,
      tabId: 42,
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'tabs.close');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {
      tabId: 42,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx tabs.list uses the dotted-method shortcut and prints the raw bridge result', async () => {
  const bridgeServer = await bridgeServerWith({
    'tabs.list': (request) =>
      createSuccess(request.id, {
        tabs: [
          {
            tabId: 3,
            active: false,
            origin: 'https://example.com',
            title: 'Shortcut Tab',
          },
        ],
      }),
  });

  try {
    const result = await runCli({
      args: ['tabs.list'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.json, {
      tabs: [
        {
          tabId: 3,
          active: false,
          origin: 'https://example.com',
          title: 'Shortcut Tab',
        },
      ],
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'tabs.list');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {});
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx click resolves a selector before dispatching the shortcut bridge method', async () => {
  const bridgeServer = await bridgeServerWith({
    'dom.query': (request) =>
      createSuccess(request.id, {
        nodes: [{ elementRef: 'el_button_2', tag: 'button' }],
        total: 1,
      }),
    'input.click': (request) =>
      createSuccess(request.id, {
        clicked: true,
        elementRef: 'el_button_2',
      }),
  });

  try {
    const result = await runCli({
      args: ['click', '#save', 'right'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Clicked el_button_2.');
    assert.deepEqual(payload.evidence, {
      elementRef: 'el_button_2',
    });
    assert.equal(bridgeServer.requests.length, 3);
    assert.equal(bridgeServer.requests[1].method, 'dom.query');
    assert.deepEqual(bridgeServer.requests[1].params, {
      selector: '#save',
      withinRef: null,
      budget: {
        maxNodes: 25,
        maxDepth: 4,
        textBudget: 600,
        includeBbox: true,
        attributeAllowlist: [],
      },
    });
    assert.equal(bridgeServer.requests[2].method, 'input.click');
    assert.equal(bridgeServer.requests[2].tab_id, null);
    assert.deepEqual(bridgeServer.requests[2].params, {
      target: {
        elementRef: 'el_button_2',
      },
      button: 'right',
      clickCount: 1,
      text: '',
      value: '',
      mode: 'auto',
      clear: false,
      submit: false,
      key: '',
      modifiers: [],
    });
    assert.equal(bridgeServer.requests[2].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx click re-resolves the selector and retries once on ELEMENT_STALE', async () => {
  let queryCount = 0;
  let clickCount = 0;
  const bridgeServer = await bridgeServerWith({
    'dom.query': (request) => {
      queryCount += 1;
      return createSuccess(request.id, {
        nodes: [{ elementRef: `el_button_${queryCount}`, tag: 'button' }],
        total: 1,
      });
    },
    'input.click': (request) => {
      clickCount += 1;
      if (clickCount === 1) {
        return createFailure(request.id, 'ELEMENT_STALE', 'Element reference is stale.', null, {
          method: 'input.click',
        });
      }
      return createSuccess(request.id, {
        clicked: true,
        elementRef: 'el_button_2',
      });
    },
  });

  try {
    const result = await runCli({
      args: ['click', '#save'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(payload.ok, true);
    assert.match(result.stderr, /ELEMENT_STALE on "#save", re-resolving and retrying/);
    assert.equal(queryCount, 2);
    assert.equal(clickCount, 2);
    // Second click must target the freshly resolved ref, not the stale one.
    const clickRequests = bridgeServer.requests.filter((r) => r.method === 'input.click');
    assert.deepEqual(
      clickRequests.map((r) => (r.params.target as { elementRef: string }).elementRef),
      ['el_button_1', 'el_button_2']
    );
  } finally {
    await bridgeServer.close();
  }
});

test('bbx click with an explicit ref does not retry on ELEMENT_STALE', async () => {
  let clickCount = 0;
  const bridgeServer = await bridgeServerWith({
    'input.click': (request) => {
      clickCount += 1;
      return createFailure(request.id, 'ELEMENT_STALE', 'Element reference is stale.', null, {
        method: 'input.click',
      });
    },
  });

  try {
    const result = await runCli({
      args: ['click', 'el_gone_1'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(payload.ok, false);
    assert.equal(clickCount, 1);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx console dispatches a shortcut command without selector resolution', async () => {
  const bridgeServer = await bridgeServerWith({
    'page.get_console': (request) =>
      createSuccess(request.id, {
        count: 1,
        total: 1,
        entries: [
          {
            level: 'warn',
            args: ['be careful'],
          },
        ],
      }),
  });

  try {
    const result = await runCli({
      args: ['console', 'warn'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Console: 1 entries (1 total).');
    assert.deepEqual(payload.evidence, [
      {
        level: 'warn',
        args: ['be careful'],
      },
    ]);
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'page.get_console');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {
      level: 'warn',
      clear: false,
      limit: 50,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx press-key without a selector sends a page-level input.press_key request', async () => {
  const bridgeServer = await bridgeServerWith({
    'input.press_key': (request) =>
      createSuccess(request.id, {
        pressed: true,
        key: 'Enter',
      }),
  });

  try {
    const result = await runCli({
      args: ['press-key', 'Enter'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Key pressed \(Enter\)\./);
    assert.deepEqual(payload.evidence, {
      pressed: true,
      key: 'Enter',
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'input.press_key');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {
      button: 'left',
      clickCount: 1,
      clear: false,
      key: 'Enter',
      mode: 'auto',
      modifiers: [],
      submit: false,
      target: {},
      text: '',
      value: '',
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx press-key resolves a selector before forwarding input.press_key', async () => {
  const bridgeServer = await bridgeServerWith({
    'dom.query': (request) =>
      createSuccess(request.id, {
        nodes: [{ elementRef: 'el_button_1', tag: 'button' }],
        total: 1,
      }),
    'input.press_key': (request) =>
      createSuccess(request.id, {
        pressed: true,
        key: 'Escape',
        elementRef: 'el_button_1',
      }),
  });

  try {
    const result = await runCli({
      args: ['press-key', 'Escape', '#dismiss'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /Key pressed \(Escape\)\./);
    assert.deepEqual(payload.evidence, {
      pressed: true,
      key: 'Escape',
      elementRef: 'el_button_1',
    });
    assert.equal(bridgeServer.requests.length, 3);
    assert.equal(bridgeServer.requests[1].method, 'dom.query');
    assert.deepEqual(bridgeServer.requests[1].params, {
      selector: '#dismiss',
      withinRef: null,
      budget: {
        maxNodes: 25,
        maxDepth: 4,
        textBudget: 600,
        includeBbox: true,
        attributeAllowlist: [],
      },
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.equal(bridgeServer.requests[2].method, 'input.press_key');
    assert.equal(bridgeServer.requests[2].tab_id, null);
    assert.deepEqual(bridgeServer.requests[2].params, {
      button: 'left',
      clickCount: 1,
      clear: false,
      key: 'Escape',
      mode: 'auto',
      modifiers: [],
      submit: false,
      target: {
        elementRef: 'el_button_1',
      },
      text: '',
      value: '',
    });
    assert.equal(bridgeServer.requests[2].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx press-key without a key reports the usage error', async () => {
  const result = await runCli({
    args: ['press-key'],
    env: process.env,
  });
  const payload = expectCliPayload(result.json);

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: Usage: press-key <key> [ref|selector]');
});

test('bbx cdp-press-key forwards key and code to cdp.dispatch_key_event', async () => {
  const bridgeServer = await bridgeServerWith({
    'cdp.dispatch_key_event': (request) =>
      createSuccess(request.id, {
        method: 'Input.dispatchKeyEvent',
        pressed: true,
        key: 'Escape',
        code: 'Escape',
        dispatched: ['keyDown', 'keyUp'],
      }),
  });

  try {
    const result = await runCli({
      args: ['cdp-press-key', '--tab', '17', 'Escape', 'Escape'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Key pressed (Escape).');
    assert.deepEqual(payload.evidence, {
      method: 'Input.dispatchKeyEvent',
      pressed: true,
      key: 'Escape',
      code: 'Escape',
      dispatched: ['keyDown', 'keyUp'],
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'cdp.dispatch_key_event');
    assert.equal(bridgeServer.requests[1].tab_id, 17);
    assert.deepEqual(bridgeServer.requests[1].params, {
      key: 'Escape',
      code: 'Escape',
      modifiers: [],
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx cdp-press-key without a key reports the usage error', async () => {
  const result = await runCli({
    args: ['cdp-press-key'],
    env: process.env,
  });
  const payload = expectCliPayload(result.json);

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: Usage: cdp-press-key [--tab <tabId>] <key> [code]');
});

test('bbx call reads params JSON from stdin when passed - and forwards the normalized request', async () => {
  const bridgeServer = await bridgeServerWith({
    'page.evaluate': (request) =>
      createSuccess(request.id, {
        value: 'stdin branch',
      }),
  });

  try {
    const result = await runCli({
      args: ['call', 'page.evaluate', '-'],
      stdin: '{"expression":"document.title"}',
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json;

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(payload, {
      value: 'stdin branch',
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'page.evaluate');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {
      expression: 'document.title',
      awaitPromise: false,
      timeoutMs: 5000,
      returnByValue: true,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx call without a method reports the usage error from parseCallCommand', async () => {
  const result = await runCli({
    args: ['call'],
    env: process.env,
  });
  const payload = expectCliPayload(result.json);

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: Usage: call [--tab <tabId>] <method> [paramsJson]');
});

test('bbx call rejects a first arg without a dotted bridge method name', async () => {
  const result = await runCli({
    args: ['call', 'notamethod'],
    env: process.env,
  });
  const payload = expectCliPayload(result.json);

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: Usage: call [--tab <tabId>] <method> [paramsJson]');
});

test('bbx call rejects an invalid --tab flag before dispatching the bridge request', async () => {
  const result = await runCli({
    args: ['call', '--tab', 'abc', 'page.evaluate', '{}'],
    env: process.env,
  });
  const payload = expectCliPayload(result.json);

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: tabId must be a positive integer (got "abc").');
});

test('bbx call rejects extra positional arguments before connecting', async () => {
  const bridgeServer = await bridgeServerWith({});

  try {
    const result = await runCli({
      args: ['call', 'page.evaluate', '{}', 'extra'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.equal(payload.summary, 'ERROR: Usage: call [--tab <tabId>] <method> [paramsJson]');
    assert.equal(bridgeServer.messages.length, 0);
    assert.equal(bridgeServer.requests.length, 0);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx batch rejects invalid JSON before connecting', async () => {
  const bridgeServer = await bridgeServerWith({});

  try {
    const result = await runCli({
      args: ['batch', '{broken'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.equal(
      payload.summary,
      'ERROR: Invalid JSON syntax. Expected a JSON array of bridge calls.'
    );
    assert.equal(bridgeServer.messages.length, 0);
    assert.equal(bridgeServer.requests.length, 0);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx batch rejects non-array JSON before connecting', async () => {
  const bridgeServer = await bridgeServerWith({});

  try {
    const result = await runCli({
      args: ['batch', '{"method":"health.ping"}'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, false);
    assert.equal(payload.evidence, null);
    assert.equal(payload.summary, 'ERROR: Batch input must be a JSON array.');
    assert.equal(bridgeServer.messages.length, 0);
    assert.equal(bridgeServer.requests.length, 0);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx batch reports unknown methods without dispatching them', async () => {
  const bridgeServer = await bridgeServerWith({});

  try {
    const result = await runCli({
      args: ['batch', '[{"method":"not.real.method","params":{}}]'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = result.json as Array<{
      method: string;
      ok: boolean;
      summary: string;
      error: { code: string; message: string };
    }>;

    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(payload, [
      {
        method: 'not.real.method',
        tabId: null,
        ok: false,
        summary: 'INVALID_REQUEST: Unknown bridge method "not.real.method".',
        evidence: null,
        durationMs: 0,
        approxTokens: 0,
        meta: { protocol_version: PROTOCOL_VERSION },
        error: {
          code: 'INVALID_REQUEST',
          message: 'Unknown bridge method "not.real.method".',
        },
        response: null,
      },
    ]);
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      ['health.ping']
    );
  } finally {
    await bridgeServer.close();
  }
});

test('bbx batch rejects non-object params and exits unsuccessfully', async () => {
  const bridgeServer = await bridgeServerWith({});
  try {
    const result = await runCli({
      args: ['batch', '[{"method":"tabs.list","params":[]}]'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });
    const payload = result.json as Array<{ ok: boolean; error: { message: string } }>;
    assert.equal(result.status, 1);
    assert.equal(payload[0].ok, false);
    assert.equal(payload[0].error.message, 'Batch call params must be a JSON object.');
    assert.deepEqual(
      bridgeServer.requests.map((request) => request.method),
      ['health.ping']
    );
  } finally {
    await bridgeServer.close();
  }
});

test('bbx batch uses operation-aware timeout and preserves tab routing and metadata', async () => {
  const bridgeServer = await bridgeServerWith({
    'page.evaluate': async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return createSuccess(request.id, { value: 4 });
    },
  });
  try {
    const result = await runCli({
      args: [
        'batch',
        '[{"method":"page.evaluate","tabId":17,"params":{"expression":"2 + 2","timeoutMs":100}}]',
      ],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
        BBX_CLIENT_REQUEST_TIMEOUT_MS: '10',
      },
    });
    const payload = result.json as Array<{ ok: boolean }>;
    assert.equal(result.status, 0, result.stdout);
    assert.equal(payload[0].ok, true);
    assert.equal(bridgeServer.requests[1].tab_id, 17);
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.equal(bridgeServer.requests[1].params.timeoutMs, 100);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx intercept add parses status separately from response body', async () => {
  const bridgeServer = await bridgeServerWith({
    'network.intercept.add': (request) => createSuccess(request.id, { ruleId: 'rule-1' }),
  });
  try {
    const result = await runCli({
      args: ['intercept', 'add', '*example*', '--respond', 'hello world', '--status', '201'],
      env: { ...process.env, BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome },
    });
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(bridgeServer.requests[1].params, {
      urlPattern: '*example*',
      action: 'fulfill',
      statusCode: 201,
      body: 'hello world',
    });
  } finally {
    await bridgeServer.close();
  }
});

test('bbx intercept rejects conflicting, unknown, extra, and invalid status options', async () => {
  const cases = [
    { args: ['intercept', 'add'], message: /Usage: intercept add/u },
    { args: ['intercept', 'add', '--block'], message: /Usage: intercept add/u },
    {
      args: ['intercept', 'add', '*', '--block', '--respond', 'body'],
      message: /either --block or --respond/u,
    },
    {
      args: ['intercept', 'add', '*', '--block', '--block'],
      message: /--block option may only be specified once/u,
    },
    {
      args: ['intercept', 'add', '*', '--respond', 'one', '--respond', 'two'],
      message: /--respond option may only be specified once/u,
    },
    {
      args: ['intercept', 'add', '*', '--respond'],
      message: /--respond requires a body value/u,
    },
    {
      args: ['intercept', 'add', '*', '--status', '200', '--status', '201'],
      message: /--status option may only be specified once/u,
    },
    { args: ['intercept', 'add', '*', '--unknown'], message: /Unknown or extra/u },
    {
      args: ['intercept', 'add', '*', '--respond', 'body', 'extra'],
      message: /Unknown or extra/u,
    },
    {
      args: ['intercept', 'add', '*', '--status', '99'],
      message: /between 100 and 599/u,
    },
    {
      args: ['intercept', 'add', '*', '--status', '200.5'],
      message: /positive integer/u,
    },
    { args: ['intercept', 'remove'], message: /Usage: intercept remove/u },
    { args: ['intercept', 'remove', 'rule-1', 'extra'], message: /Usage: intercept remove/u },
    { args: ['intercept', 'list', 'extra'], message: /Usage: intercept list/u },
    { args: ['intercept', 'clear', 'extra'], message: /Usage: intercept clear/u },
    { args: ['intercept', 'unknown'], message: /Usage: intercept/u },
  ];
  for (const entry of cases) {
    const result = await runCli({ args: entry.args, env: process.env });
    const payload = expectCliPayload(result.json);
    assert.equal(result.status, 1);
    assert.match(payload.summary, entry.message);
  }
});

test('bbx eval joins the inline expression arguments and summarizes page.evaluate output', async () => {
  const bridgeServer = await bridgeServerWith({
    'page.evaluate': (request) =>
      createSuccess(request.id, {
        type: 'number',
        value: 4,
      }),
  });

  try {
    const result = await runCli({
      args: ['eval', '2', '+', '2'],
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Evaluated to number: 4');
    assert.deepEqual(payload.evidence, {
      type: 'number',
      value: 4,
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'page.evaluate');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {
      expression: '2 + 2',
      awaitPromise: false,
      timeoutMs: 5000,
      returnByValue: true,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx eval reads the expression from stdin when passed -', async () => {
  const bridgeServer = await bridgeServerWith({
    'page.evaluate': (request) =>
      createSuccess(request.id, {
        type: 'string',
        value: 'Example Title',
      }),
  });

  try {
    const result = await runCli({
      args: ['eval', '-'],
      stdin: 'document.title',
      env: {
        ...process.env,
        BROWSER_BRIDGE_HOME: bridgeServer.bridgeHome,
      },
    });
    const payload = expectCliPayload(result.json);

    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.equal(payload.ok, true);
    assert.equal(payload.summary, 'Evaluated to string: Example Title');
    assert.deepEqual(payload.evidence, {
      type: 'string',
      value: 'Example Title',
    });
    assert.equal(bridgeServer.requests.length, 2);
    assert.equal(bridgeServer.requests[1].method, 'page.evaluate');
    assert.equal(bridgeServer.requests[1].tab_id, null);
    assert.deepEqual(bridgeServer.requests[1].params, {
      expression: 'document.title',
      awaitPromise: false,
      timeoutMs: 5000,
      returnByValue: true,
    });
    assert.equal(bridgeServer.requests[1].meta.source, 'cli');
    assert.deepEqual(bridgeServer.errors, []);
  } finally {
    await bridgeServer.close();
  }
});

test('bbx eval with empty stdin reports the usage error', async () => {
  const result = await runCli({
    args: ['eval', '-'],
    stdin: '',
    env: process.env,
  });
  const payload = expectCliPayload(result.json);

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(
    payload.summary,
    'ERROR: Usage: eval [--tab <id>] [--await] <expression>  (or pipe via stdin: echo "expr" | bbx eval -)'
  );
});

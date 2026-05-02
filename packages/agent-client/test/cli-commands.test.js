// @ts-check

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSuccess } from '../../protocol/src/index.js';
import { PUBLISHED_EXTENSION_ID } from '../../native-host/src/config.js';
import { runCli } from '../../../tests/_helpers/runCli.js';
import { createInstallFs } from '../../../tests/_helpers/installFs.js';
import { bridgeServerWith } from '../../../tests/_helpers/socketHarness.js';

/**
 * @param {Awaited<ReturnType<typeof createInstallFs>>} installFs
 * @returns {Promise<void>}
 */
async function seedInstalledBrowserManifests(installFs) {
  const manifest = `${JSON.stringify(
    {
      name: 'com.browserbridge.browser_bridge',
      allowed_origins: [`chrome-extension://${PUBLISHED_EXTENSION_ID}/`],
    },
    null,
    2
  )}\n`;

  await Promise.all(
    Object.values(installFs.browserManifests).map(async ({ installDir, manifestPath }) => {
      await fs.promises.mkdir(installDir, { recursive: true });
      await fs.promises.writeFile(manifestPath, manifest, 'utf8');
    })
  );
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
    const payload = result.json;

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

test('bbx doctor reports readiness issues when the manifest and daemon are missing', async () => {
  const installFs = await createInstallFs({ prefix: 'bbx-doctor-issues-' });

  try {
    const result = await runCli({
      args: ['doctor'],
      env: installFs.env,
    });
    const payload = result.json;

    assert.equal(result.status, 0);
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
        /** @param {{ installed: boolean }} entry */
        (entry) => entry.installed === false
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
    const payload = result.json;

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
    const payload = result.json;

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
    assert.deepEqual(bridgeServer.requests[1].params, {});
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
    const payload = result.json;

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
    const payload = result.json;

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
    const payload = result.json;

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
    const payload = result.json;

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
    const payload = result.json;

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
    const payload = result.json;

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
    const payload = result.json;

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
      modifiers: [],
      submit: false,
      target: {},
      text: '',
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
    const payload = result.json;

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
      modifiers: [],
      submit: false,
      target: {
        elementRef: 'el_button_1',
      },
      text: '',
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
  const payload = result.json;

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: Usage: press-key <key> [ref|selector]');
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
  const payload = result.json;

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
  const payload = result.json;

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
  const payload = result.json;

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(payload.summary, 'ERROR: tabId must be a number (got "abc").');
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
    const payload = result.json;

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
    const payload = result.json;

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
  const payload = result.json;

  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(payload.ok, false);
  assert.equal(payload.evidence, null);
  assert.equal(
    payload.summary,
    'ERROR: Usage: eval <expression>  (or pipe via stdin: echo "expr" | bbx eval -)'
  );
});

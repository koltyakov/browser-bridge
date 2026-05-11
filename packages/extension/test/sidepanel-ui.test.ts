import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createChromeFake } from '../../../tests/_helpers/chromeFake.ts';
import { withDocument } from '../../../tests/_helpers/dom.ts';
import { createMessagePortPair } from '../../../tests/_helpers/messagePort.ts';
import type { SetupStatus } from '../../protocol/src/types.js';

const MISSING = Symbol('missing');
const SIDEPANEL_HTML_URL = new URL('../ui/sidepanel.html', import.meta.url);
const SIDEPANEL_SCRIPT_URL = new URL('../ui/sidepanel.js', import.meta.url);

type SidepanelStateSync = {
  type: 'state.sync';
  state: {
    nativeConnected: true;
    nativeHostVersion: string | null;
    currentTab: SidepanelCurrentTab | null;
    setupStatus: SetupStatus | null;
    setupStatusPending: boolean;
    setupStatusError: string | null;
    setupInstallPendingKey: string | null;
    setupInstallError: string | null;
    actionLog: ActionLogEntry[];
  };
};
type SidepanelCurrentTab = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  enabled: boolean;
  accessRequested: boolean;
  restricted: boolean;
};
type ActionLogEntry = {
  id: string;
  at: number;
  method: string;
  source: string;
  tabId: number | null;
  url: string;
  ok: boolean;
  summary: string;
  responseBytes: number;
  approxTokens: number;
  imageApproxTokens: number;
  costClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
  imageBytes: number;
  summaryBytes: number;
  summaryTokens: number;
  summaryCostClass: 'cheap' | 'moderate' | 'heavy' | 'extreme';
  debuggerBacked: boolean;
  overBudget: boolean;
  hasScreenshot: boolean;
  nodeCount: number | null;
  continuationHint: string | null;
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function importFreshSidepanelScript(): Promise<void> {
  await import(`${SIDEPANEL_SCRIPT_URL.href}?case=${Date.now()}-${Math.random()}`);
}

function restoreGlobal(key: string, savedValue: unknown): void {
  if (savedValue === MISSING) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }

  Reflect.set(globalThis, key, savedValue);
}

function createSidepanelStateSync(
  enabled: boolean,
  setupStatus: SetupStatus | null = null,
  nativeHostVersion: string | null = null,
  actionLog: ActionLogEntry[] = [],
  stateOverrides: Partial<SidepanelStateSync['state']> = {}
): SidepanelStateSync {
  const state: SidepanelStateSync['state'] = {
    nativeConnected: true,
    nativeHostVersion,
    currentTab: {
      tabId: 41,
      windowId: 7,
      title: 'Example page',
      url: 'https://example.com/',
      enabled,
      accessRequested: false,
      restricted: false,
    },
    setupStatus,
    setupStatusPending: false,
    setupStatusError: null,
    setupInstallPendingKey: null,
    setupInstallError: null,
    actionLog,
  };

  return {
    type: 'state.sync',
    state: { ...state, ...stateOverrides },
  };
}

function createUnconfiguredSetupStatus(): SetupStatus {
  return {
    scope: 'global',
    mcpClients: [
      {
        key: 'cursor',
        label: 'Cursor',
        detected: true,
        configPath: '/configs/cursor.json',
        configExists: false,
        configured: false,
      },
    ],
    skillTargets: [
      {
        key: 'cursor',
        label: 'Cursor',
        detected: true,
        basePath: '/skills/cursor',
        installed: false,
        managed: false,
        installedVersion: null,
        currentVersion: null,
        updateAvailable: false,
        skills: [],
      },
    ],
  };
}

function createRichSetupStatus(): SetupStatus {
  return {
    scope: 'global',
    mcpClients: [
      {
        key: 'claude',
        label: 'Claude',
        detected: true,
        configPath: '/configs/claude.json',
        configExists: true,
        configured: true,
      },
      {
        key: 'cursor',
        label: 'Cursor',
        detected: true,
        configPath: '/configs/cursor.json',
        configExists: false,
        configured: false,
      },
      {
        key: 'agents',
        label: 'Generic Agents',
        detected: false,
        configPath: '/configs/agents.json',
        configExists: false,
        configured: false,
      },
    ],
    skillTargets: [
      {
        key: 'claude',
        label: 'Claude',
        detected: true,
        basePath: '/skills/claude',
        installed: true,
        managed: true,
        installedVersion: '1.0.0',
        currentVersion: '1.0.0',
        updateAvailable: false,
        skills: [
          {
            name: 'browser-bridge',
            path: '/skills/claude/browser-bridge',
            exists: true,
            managed: true,
            version: '1.0.0',
          },
        ],
      },
      {
        key: 'cursor',
        label: 'Cursor',
        detected: true,
        basePath: '/skills/cursor',
        installed: true,
        managed: true,
        installedVersion: '1.0.0',
        currentVersion: '1.2.0',
        updateAvailable: true,
        skills: [
          {
            name: 'browser-bridge',
            path: '/skills/cursor/browser-bridge',
            exists: true,
            managed: true,
            version: '1.0.0',
          },
        ],
      },
      {
        key: 'opencode',
        label: 'OpenCode',
        detected: true,
        basePath: '/skills/opencode',
        installed: true,
        managed: false,
        installedVersion: null,
        currentVersion: null,
        updateAvailable: false,
        skills: [
          {
            name: 'browser-bridge',
            path: '/skills/opencode/browser-bridge',
            exists: true,
            managed: false,
            version: null,
          },
        ],
      },
      {
        key: 'windsurf',
        label: 'Windsurf',
        detected: true,
        basePath: '/skills/windsurf',
        installed: false,
        managed: false,
        installedVersion: null,
        currentVersion: null,
        updateAvailable: false,
        skills: [],
      },
    ],
  };
}

function getSetupContextMenuButtons(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll('button')].filter(
    (button): button is HTMLButtonElement => button instanceof HTMLButtonElement
  );
}

function createActionLogEntry(
  id: string,
  method: string,
  approxTokens: number,
  overrides: Partial<ActionLogEntry> = {}
): ActionLogEntry {
  const costClass =
    approxTokens > 3000
      ? 'extreme'
      : approxTokens > 1000
        ? 'heavy'
        : approxTokens > 250
          ? 'moderate'
          : 'cheap';
  return {
    id,
    at: Date.now(),
    method,
    source: 'cli',
    tabId: 41,
    url: 'https://example.com/',
    ok: true,
    summary: `Ran ${method}`,
    responseBytes: approxTokens * 4,
    approxTokens,
    imageApproxTokens: 0,
    costClass,
    imageBytes: 0,
    summaryBytes: 80,
    summaryTokens: approxTokens,
    summaryCostClass: costClass,
    debuggerBacked: false,
    overBudget: false,
    hasScreenshot: false,
    nodeCount: null,
    continuationHint: null,
    ...overrides,
  };
}

test('sidepanel UI smoke test flips the action label between enable and disable states', async (t) => {
  const sidepanelHtml = await readFile(SIDEPANEL_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetInterval = globalThis.setInterval;
  const savedClearInterval = globalThis.clearInterval;
  t.after(() => {
    restoreGlobal('chrome', savedChrome);
    restoreGlobal('setInterval', savedSetInterval);
    restoreGlobal('clearInterval', savedClearInterval);
  });

  const intervalCalls: Array<{ delay: number | undefined }> = [];
  const portPair = createMessagePortPair();

  Reflect.set(globalThis, 'setInterval', ((callback: TimerHandler, delay?: number) => {
    intervalCalls.push({ delay });
    void callback;
    return { id: 'sidepanel-interval' } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  Reflect.set(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      runtime: {
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    await importFreshSidepanelScript();
    await flushMicrotasks();

    assert.deepEqual(intervalCalls, [{ delay: 5_000 }]);
    assert.deepEqual(portPair.left.postedMessages, [{ type: 'state.request' }]);
    assert.equal(portPair.left.onMessageListeners.length, 1);

    const button = document.getElementById('bridge-toggle') as HTMLButtonElement | null;
    assert.ok(button, 'sidepanel toggle button should be present');

    portPair.left.dispatchMessage(createSidepanelStateSync(false));
    assert.equal(button.textContent, 'Enable Window Access');
    assert.equal(button.disabled, false);

    portPair.left.dispatchMessage(createSidepanelStateSync(true));
    assert.equal(button.textContent, 'Disable Window Access');
    assert.equal(button.disabled, false);
  });
});

test('sidepanel UI shows the global host CLI and daemon version', async (t) => {
  const sidepanelHtml = await readFile(SIDEPANEL_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetInterval = globalThis.setInterval;
  const savedClearInterval = globalThis.clearInterval;
  t.after(() => {
    restoreGlobal('chrome', savedChrome);
    restoreGlobal('setInterval', savedSetInterval);
    restoreGlobal('clearInterval', savedClearInterval);
  });

  const portPair = createMessagePortPair();

  Reflect.set(globalThis, 'setInterval', (() => {
    return { id: 'sidepanel-version-interval' } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  Reflect.set(globalThis, 'clearInterval', (() => {}) as typeof clearInterval);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      runtime: {
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    await importFreshSidepanelScript();
    await flushMicrotasks();

    portPair.left.dispatchMessage(createSidepanelStateSync(true, null, '1.2.0'));

    const hostVersion = document.getElementById('setup-host-version');
    assert.ok(hostVersion instanceof HTMLElement);
    assert.equal(hostVersion.textContent, 'Daemon version: v1.2.0');
    assert.equal(hostVersion.hidden, false);
  });
});

test('sidepanel UI renders activity summaries, histogram families, and repeat warnings', async (t) => {
  const sidepanelHtml = await readFile(SIDEPANEL_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetInterval = globalThis.setInterval;
  const savedClearInterval = globalThis.clearInterval;
  const savedDateNow = Date.now;
  t.after(() => {
    restoreGlobal('chrome', savedChrome);
    restoreGlobal('setInterval', savedSetInterval);
    restoreGlobal('clearInterval', savedClearInterval);
    Date.now = savedDateNow;
  });

  const baseTime = 1_800_000;
  Date.now = () => baseTime;
  const intervalCallbacks: Array<() => void> = [];
  const clearedIntervals: unknown[] = [];
  const portPair = createMessagePortPair();

  Reflect.set(globalThis, 'setInterval', ((callback: TimerHandler, delay?: number) => {
    assert.equal(delay, 5_000);
    intervalCallbacks.push(() => {
      if (typeof callback === 'function') callback();
    });
    return { id: `sidepanel-activity-${intervalCallbacks.length}` } as unknown as ReturnType<
      typeof setInterval
    >;
  }) as unknown as typeof setInterval);
  Reflect.set(globalThis, 'clearInterval', ((timer: unknown) => {
    clearedIntervals.push(timer);
  }) as typeof clearInterval);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      runtime: {
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    Reflect.set(window, 'innerWidth', 900);
    Reflect.set(window, 'innerHeight', 700);
    await importFreshSidepanelScript();
    await flushMicrotasks();

    const summaryTokens = document.getElementById('activity-summary-tokens');
    const histogram = document.getElementById('activity-histogram');
    const bars = document.getElementById('activity-histogram-bars');
    const actionLog = document.getElementById('action-log');
    assert.ok(summaryTokens instanceof HTMLElement);
    assert.ok(histogram instanceof HTMLElement);
    assert.ok(bars instanceof HTMLElement);
    assert.ok(actionLog instanceof HTMLElement);

    portPair.left.dispatchMessage(
      createSidepanelStateSync(true, null, null, [createActionLogEntry('cheap', 'dom.query', 100)])
    );
    assert.equal(summaryTokens.textContent, '≈100 tok');
    assert.equal(summaryTokens.dataset.costClass, 'cheap');

    portPair.left.dispatchMessage(
      createSidepanelStateSync(true, null, null, [
        createActionLogEntry('moderate', 'page.get_text', 500),
      ])
    );
    assert.equal(summaryTokens.dataset.costClass, 'moderate');

    portPair.left.dispatchMessage(
      createSidepanelStateSync(true, null, null, [
        createActionLogEntry('heavy', 'layout.get_box_model', 1_500),
      ])
    );
    assert.equal(summaryTokens.textContent, '≈1.5k tok');
    assert.equal(summaryTokens.dataset.costClass, 'heavy');

    const activityEntries = [
      createActionLogEntry('repeat-extreme-1', 'dom.describe', 10, {
        costClass: 'heavy',
        summaryTokens: 0,
      }),
      createActionLogEntry('repeat-extreme-2', 'dom.describe', 10, {
        costClass: 'extreme',
        summaryTokens: 0,
      }),
      createActionLogEntry('repeat-extreme-3', 'dom.describe', 10, {
        costClass: 'extreme',
        summaryTokens: 0,
      }),
      createActionLogEntry('repeat-1', 'cdp.get_document', 1_200, { debuggerBacked: true }),
      createActionLogEntry('repeat-2', 'cdp.get_document', 1_100, { debuggerBacked: true }),
      createActionLogEntry('repeat-3', 'cdp.get_document', 1_050, { debuggerBacked: true }),
      createActionLogEntry('dom', 'dom.query', 800),
      createActionLogEntry('page', 'page.get_text', 700),
      createActionLogEntry('layout', 'layout.get_box_model', 650),
      createActionLogEntry('style', 'styles.get_computed', 600),
      createActionLogEntry('input', 'input.click', 550),
      createActionLogEntry('navigation', 'navigation.navigate', 500),
      createActionLogEntry('viewport', 'viewport.scroll', 450),
      createActionLogEntry('patch', 'patch.apply_styles', 400),
      createActionLogEntry('screenshot', 'screenshot.capture_element', 350, {
        hasScreenshot: true,
        imageBytes: 2048,
      }),
      createActionLogEntry('hint', 'dom.get_html', 0, {
        continuationHint: 'Use maxLength to continue reading the HTML.',
        imageApproxTokens: 20,
        imageBytes: 512,
        nodeCount: 3,
        overBudget: true,
      }),
      createActionLogEntry('medium-image', 'screenshot.capture_region', 0, {
        imageApproxTokens: 40,
        imageBytes: 20 * 1024,
      }),
      createActionLogEntry('large-image', 'screenshot.capture_full_page', 0, {
        imageApproxTokens: 40,
        imageBytes: 2 * 1024 * 1024,
      }),
      createActionLogEntry('no-token', 'dom.query', 0),
      createActionLogEntry('invalid-time', 'dom.query', 100, { at: Number.NaN }),
      createActionLogEntry('performance', 'performance.get_metrics', 300),
      createActionLogEntry('other', 'health.ping', 3_400),
    ];
    portPair.left.dispatchMessage(createSidepanelStateSync(true, null, null, activityEntries));

    assert.equal(summaryTokens.textContent, '≈12k tok');
    assert.equal(summaryTokens.dataset.costClass, 'extreme');
    assert.equal(histogram.hidden, false);
    assert.equal(bars.childElementCount, 20);
    const segmentFamilies = new Set(
      [...bars.querySelectorAll('.activity-histogram-segment')].map(
        (segment) => (segment as HTMLElement).dataset.family
      )
    );
    assert.deepEqual(
      [...segmentFamilies].sort(),
      ['capture', 'dom', 'input', 'layout', 'other', 'page', 'patch', 'style'].sort()
    );
    assert.match(actionLog.textContent ?? '', /Repeat/);
    assert.match(actionLog.textContent ?? '', /Image/);
    assert.match(actionLog.textContent ?? '', /Debugger/);
    assert.match(actionLog.textContent ?? '', /Truncated/);
    assert.match(actionLog.textContent ?? '', /Use maxLength to continue reading the HTML\./);
    assert.match(actionLog.textContent ?? '', /3n/);
    assert.match(actionLog.textContent ?? '', /512 B img/);
    assert.match(actionLog.textContent ?? '', /20 KB img/);
    assert.match(actionLog.textContent ?? '', /2 MB img/);

    assert.equal(intervalCallbacks.length, 1);
    intervalCallbacks[0]();
    assert.equal(summaryTokens.dataset.costClass, 'extreme');

    Date.now = () => Number.NaN;
    portPair.left.dispatchMessage(
      createSidepanelStateSync(true, null, null, [
        createActionLogEntry('empty-histogram', 'dom.query', 0, { at: Number.NaN }),
      ])
    );
    assert.equal(histogram.hidden, true);
    assert.equal(summaryTokens.hidden, true);

    window.dispatchEvent(new Event('beforeunload'));
    assert.equal(clearedIntervals.length, 1);
  });
});

test('sidepanel UI handles setup matrix actions, context menus, diagnostics, and toggles', async (t) => {
  const sidepanelHtml = await readFile(SIDEPANEL_HTML_URL, 'utf8');
  const savedChrome = Object.prototype.hasOwnProperty.call(globalThis, 'chrome')
    ? globalThis.chrome
    : MISSING;
  const savedSetInterval = globalThis.setInterval;
  const savedClearInterval = globalThis.clearInterval;
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  t.after(() => {
    restoreGlobal('chrome', savedChrome);
    restoreGlobal('setInterval', savedSetInterval);
    restoreGlobal('clearInterval', savedClearInterval);
    restoreGlobal('setTimeout', savedSetTimeout);
    restoreGlobal('clearTimeout', savedClearTimeout);
  });

  type SidepanelPostedMessage = { type: string; [key: string]: unknown };
  type SidepanelReceivedMessage =
    | SidepanelStateSync
    | { type: 'native.status'; connected: boolean; error?: string }
    | { type: 'toggle.error'; error: string };
  const portPairs = [
    createMessagePortPair<SidepanelPostedMessage, SidepanelReceivedMessage>(),
    createMessagePortPair<SidepanelPostedMessage, SidepanelReceivedMessage>(),
  ];
  let connectCalls = 0;
  const intervalCalls: Array<{ callback: () => void; delay: number | undefined; token: object }> =
    [];
  const timeoutCalls: Array<{ callback: () => void; delay: number | undefined; token: object }> =
    [];
  const clearedIntervals: unknown[] = [];
  const clearedTimeouts: unknown[] = [];
  const clipboardWrites: string[] = [];

  function runNextTimeout(delay: number): object {
    const timeoutCall = timeoutCalls.find(
      (call) => call.delay === delay && !clearedTimeouts.includes(call.token)
    );
    assert.ok(timeoutCall, `expected pending timeout with delay ${delay}`);
    timeoutCall.callback();
    return timeoutCall.token;
  }

  function createPointerEvent(type: string, clientX = 0, clientY = 0): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Reflect.set(event, 'clientX', clientX);
    Reflect.set(event, 'clientY', clientY);
    return event;
  }

  function createKeyEvent(key: string): Event {
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Reflect.set(event, 'key', key);
    return event;
  }

  Reflect.set(globalThis, 'setInterval', ((callback: TimerHandler, delay?: number) => {
    const token = { id: `sidepanel-setup-interval-${intervalCalls.length}` };
    intervalCalls.push({
      callback: typeof callback === 'function' ? () => callback() : () => {},
      delay,
      token,
    });
    return token as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  Reflect.set(globalThis, 'clearInterval', ((timer: unknown) => {
    clearedIntervals.push(timer);
  }) as typeof clearInterval);
  Reflect.set(globalThis, 'setTimeout', ((callback: TimerHandler, delay?: number) => {
    const token = { id: `sidepanel-setup-timeout-${timeoutCalls.length}` };
    timeoutCalls.push({
      callback: typeof callback === 'function' ? () => callback() : () => {},
      delay,
      token,
    });
    return token as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  Reflect.set(globalThis, 'clearTimeout', ((timer: unknown) => {
    clearedTimeouts.push(timer);
  }) as typeof clearTimeout);
  Reflect.set(
    globalThis,
    'chrome',
    createChromeFake({
      runtime: {
        connect(connectInfo: chrome.runtime.ConnectInfo) {
          assert.deepEqual(connectInfo, { name: 'ui-sidepanel' });
          const portPair = portPairs[Math.min(connectCalls, portPairs.length - 1)];
          connectCalls += 1;
          return portPair.left.port as unknown as chrome.runtime.Port;
        },
      },
    })
  );

  await withDocument(sidepanelHtml, async ({ window }) => {
    Reflect.set(window, 'location', new URL('https://example.com/sidepanel.html'));
    Reflect.set(window, 'innerWidth', 120);
    Reflect.set(window, 'innerHeight', 100);
    Reflect.set(navigator, 'clipboard', {
      async writeText(text: string) {
        clipboardWrites.push(text);
      },
    });
    const exampleChip = document.createElement('code');
    exampleChip.className = 'setup-cmd example-cmd';
    exampleChip.textContent = 'Do not attach the global copy listener';
    document.body.append(exampleChip);

    await importFreshSidepanelScript();
    await flushMicrotasks();

    const button = document.getElementById('bridge-toggle') as HTMLButtonElement | null;
    const installationSection = document.getElementById(
      'installation-section'
    ) as HTMLDetailsElement | null;
    const examplesSection = document.getElementById(
      'examples-section'
    ) as HTMLDetailsElement | null;
    const setupStatusMatrix = document.getElementById('setup-status-matrix');
    const setupInstallCmd = document.getElementById('setup-install-cmd');
    const contextMenu = document.querySelector('.setup-context-menu');
    assert.ok(button, 'sidepanel toggle button should be present');
    assert.ok(installationSection, 'host setup details should be present');
    assert.ok(examplesSection, 'prompt examples details should be present');
    assert.ok(setupStatusMatrix instanceof HTMLElement);
    assert.ok(setupInstallCmd instanceof HTMLElement);
    assert.ok(contextMenu instanceof HTMLElement);

    portPairs[0].left.dispatchMessage(
      createSidepanelStateSync(false, createUnconfiguredSetupStatus())
    );
    assert.equal(installationSection.open, true);
    assert.equal(examplesSection.open, false);
    assert.equal(
      intervalCalls.some((call) => call.delay === 15_000),
      true
    );
    assert.deepEqual(portPairs[0].left.postedMessages.at(-1), { type: 'setup.status.refresh' });

    setupInstallCmd.click();
    await flushMicrotasks();
    assert.equal(clipboardWrites.at(-1), 'bbx install');
    assert.equal(setupInstallCmd.classList.contains('copied'), true);
    runNextTimeout(1500);
    assert.equal(setupInstallCmd.classList.contains('copied'), false);

    examplesSection.open = true;
    installationSection.dispatchEvent(new Event('toggle'));
    assert.equal(examplesSection.open, false);

    portPairs[0].left.dispatchMessage(createSidepanelStateSync(false, createRichSetupStatus()));
    assert.match(setupStatusMatrix.textContent ?? '', /Windsurf \(beta\)/);
    assert.match(setupStatusMatrix.textContent ?? '', /Custom/);

    const cursorMcpInstall = setupStatusMatrix.querySelector(
      'button[data-kind="mcp"][data-target="cursor"]'
    );
    assert.ok(cursorMcpInstall instanceof HTMLButtonElement);
    cursorMcpInstall.click();
    assert.deepEqual(portPairs[0].left.postedMessages.at(-1), {
      type: 'setup.install',
      action: 'install',
      kind: 'mcp',
      target: 'cursor',
    });
    assert.equal(cursorMcpInstall.disabled, true);

    const claudeMcpBadge = setupStatusMatrix.querySelector(
      '[data-context-kind="mcp"][data-context-target="claude"]'
    );
    assert.ok(claudeMcpBadge instanceof HTMLElement);
    claudeMcpBadge.dispatchEvent(createPointerEvent('contextmenu', 200, 180));
    assert.equal(contextMenu.hidden, false);
    assert.equal(contextMenu.style.left, '108px');
    assert.deepEqual(
      getSetupContextMenuButtons(contextMenu).map((menuButton) => menuButton.textContent),
      ['Copy MCP config path', 'Re-install MCP', 'Uninstall MCP']
    );

    getSetupContextMenuButtons(contextMenu)[0].click();
    await flushMicrotasks();
    assert.equal(clipboardWrites.at(-1), '/configs/claude.json');
    assert.equal(contextMenu.hidden, true);

    claudeMcpBadge.dispatchEvent(createPointerEvent('contextmenu', 20, 20));
    getSetupContextMenuButtons(contextMenu)[1].click();
    assert.deepEqual(portPairs[0].left.postedMessages.at(-1), {
      type: 'setup.install',
      action: 'install',
      kind: 'mcp',
      target: 'claude',
    });

    claudeMcpBadge.dispatchEvent(createPointerEvent('contextmenu', 20, 20));
    getSetupContextMenuButtons(contextMenu)[2].click();
    assert.deepEqual(portPairs[0].left.postedMessages.at(-1), {
      type: 'setup.install',
      action: 'uninstall',
      kind: 'mcp',
      target: 'claude',
    });

    const opencodeSkillBadge = setupStatusMatrix.querySelector(
      '[data-context-kind="skill"][data-context-target="opencode"]'
    );
    assert.ok(opencodeSkillBadge instanceof HTMLElement);
    opencodeSkillBadge.dispatchEvent(createPointerEvent('contextmenu', 20, 20));
    assert.deepEqual(
      getSetupContextMenuButtons(contextMenu).map((menuButton) => menuButton.textContent),
      ['Copy CLI skill folder path']
    );
    document.dispatchEvent(createPointerEvent('click'));
    assert.equal(contextMenu.hidden, true);

    opencodeSkillBadge.dispatchEvent(createPointerEvent('contextmenu', 20, 20));
    document.dispatchEvent(createKeyEvent('Escape'));
    assert.equal(contextMenu.hidden, true);

    const postCountBeforeToggle = portPairs[0].left.postedMessages.length;
    button.click();
    assert.equal(button.dataset.pending, 'true');
    assert.equal(button.textContent, 'Enabling…');
    assert.deepEqual(portPairs[0].left.postedMessages.at(-1), {
      type: 'scope.set_enabled',
      enabled: true,
    });
    button.click();
    assert.equal(portPairs[0].left.postedMessages.length, postCountBeforeToggle + 1);

    portPairs[0].left.dispatchMessage(createSidepanelStateSync(true, createRichSetupStatus()));
    assert.equal(button.dataset.pending, 'false');
    assert.equal(button.textContent, 'Disable Window Access');

    button.click();
    portPairs[0].left.dispatchMessage({
      type: 'toggle.error',
      error: 'CONTENT_SCRIPT_UNAVAILABLE: TAB_MISMATCH',
    });
    assert.equal(button.dataset.pending, 'false');
    assert.match(document.body.textContent ?? '', /This tab is no longer available/);
    runNextTimeout(6_000);

    portPairs[0].left.dispatchMessage({
      type: 'native.status',
      connected: false,
      error: 'daemon crashed',
    });
    runNextTimeout(10_000);
    const diagnostic = document.getElementById('native-diagnostic');
    assert.ok(diagnostic instanceof HTMLElement);
    assert.match(diagnostic.textContent ?? '', /daemon crashed/);

    portPairs[0].left.dispatchMessage({
      type: 'native.status',
      connected: false,
      error: 'native host has exited',
    });
    portPairs[0].left.dispatchMessage({ type: 'native.status', connected: true });
    assert.equal(document.getElementById('native-diagnostic'), null);
    assert.equal(clearedTimeouts.length > 0, true);

    portPairs[0].left.dispatchDisconnect();
    runNextTimeout(500);
    assert.equal(connectCalls, 2);
    assert.deepEqual(portPairs[1].left.postedMessages, [{ type: 'state.request' }]);

    window.dispatchEvent(new Event('beforeunload'));
    assert.equal(clearedIntervals.length >= 2, true);
  });
});

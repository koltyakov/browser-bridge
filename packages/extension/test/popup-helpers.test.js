// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPopupToggleMessage,
  getPopupInstallCommand,
  getPopupViewState,
  normalizePopupToggleError,
  renderPopupButtonState,
  renderPopupNativeIndicator,
  renderPopupViewState,
  shouldResetPendingToggleOnSync,
} from '../src/popup-helpers.js';

test('getPopupViewState renders the unavailable state', () => {
  assert.deepEqual(getPopupViewState(null), {
    eyebrow: 'Window access unavailable',
    detail: 'Open a normal web page to manage Browser Bridge for this Chrome window.',
    disclosureHidden: false,
    attention: false,
    buttonLabel: 'Enable Window Access',
    buttonDisabled: true,
  });
});

test('getPopupViewState returns the access requested variant when access is pending', () => {
  assert.deepEqual(
    getPopupViewState({
      tabId: 10,
      windowId: 2,
      title: 'Pending access',
      url: 'https://example.com',
      enabled: false,
      accessRequested: true,
      restricted: false,
    }),
    {
      eyebrow: 'Window access requested',
      detail:
        'An agent requested access for this Chrome window. Enable it to allow page inspection and interaction.',
      disclosureHidden: false,
      attention: true,
      buttonLabel: 'Enable Window Access',
      buttonDisabled: false,
    }
  );
});

test('getPopupViewState highlights restricted enabled pages', () => {
  assert.deepEqual(
    getPopupViewState({
      tabId: 10,
      windowId: 2,
      title: 'Chrome Web Store',
      url: 'https://chromewebstore.google.com',
      enabled: true,
      accessRequested: false,
      restricted: true,
    }),
    {
      eyebrow: 'Window access enabled',
      detail:
        'This page cannot be interacted with. Switch to a normal web page to use Browser Bridge.',
      disclosureHidden: false,
      attention: false,
      buttonLabel: 'Disable Window Access',
      buttonDisabled: false,
    }
  );
});

test('getPopupViewState returns the default disabled state when access is not enabled or requested', () => {
  assert.deepEqual(
    getPopupViewState({
      tabId: 10,
      windowId: 2,
      title: 'Example',
      url: 'https://example.com',
      enabled: false,
      accessRequested: false,
      restricted: false,
    }),
    {
      eyebrow: 'Window access',
      detail:
        'Enable Browser Bridge to let your connected agent inspect and interact with pages in this Chrome window.',
      disclosureHidden: false,
      attention: false,
      buttonLabel: 'Enable Window Access',
      buttonDisabled: false,
    }
  );
});

test('createPopupToggleMessage prefers the current tab id', () => {
  assert.deepEqual(
    createPopupToggleMessage(
      true,
      {
        tabId: 42,
        windowId: 1,
        title: 'Example',
        url: 'https://example.com',
        enabled: false,
        accessRequested: false,
        restricted: false,
      },
      99
    ),
    {
      type: 'scope.set_enabled',
      enabled: true,
      tabId: 42,
    }
  );
});

test('createPopupToggleMessage falls back to popupScopeTabId when currentTab is null', () => {
  assert.deepEqual(createPopupToggleMessage(false, null, 99), {
    type: 'scope.set_enabled',
    enabled: false,
    tabId: 99,
  });
});

test('createPopupToggleMessage omits tabId when no scope is available', () => {
  assert.deepEqual(createPopupToggleMessage(false, null, null), {
    type: 'scope.set_enabled',
    enabled: false,
  });
});

test('popup helpers normalize toggle errors and detect sync completion', () => {
  assert.equal(
    normalizePopupToggleError('CONTENT_SCRIPT_UNAVAILABLE: Cannot inspect this page'),
    'Cannot inspect this page'
  );
  assert.equal(normalizePopupToggleError('Already disabled'), 'Already disabled');

  assert.equal(
    shouldResetPendingToggleOnSync(
      {
        tabId: 42,
        windowId: 1,
        title: 'Example',
        url: 'https://example.com',
        enabled: true,
        accessRequested: false,
        restricted: false,
      },
      true
    ),
    true
  );
  assert.equal(shouldResetPendingToggleOnSync(null, true), false);
  assert.equal(
    shouldResetPendingToggleOnSync(
      {
        tabId: 42,
        windowId: 1,
        title: 'Example',
        url: 'https://example.com',
        enabled: false,
        accessRequested: false,
        restricted: false,
      },
      true
    ),
    false
  );
});

test('getPopupInstallCommand uses the short published install command', () => {
  assert.equal(
    getPopupInstallCommand('jjjkmmcdkpcgamlopogicbnnhdgebhie', 'jjjkmmcdkpcgamlopogicbnnhdgebhie'),
    'bbx install'
  );
  assert.equal(
    getPopupInstallCommand('dev-extension-id', 'jjjkmmcdkpcgamlopogicbnnhdgebhie'),
    'bbx install dev-extension-id'
  );
});

test('renderPopupViewState applies the derived popup copy and button state to DOM targets', () => {
  const attention = new Set();
  const button = /** @type {HTMLButtonElement} */ ({
    textContent: '',
    disabled: false,
    dataset: {},
  });
  const targets = {
    accessEyebrow: /** @type {HTMLElement} */ ({ textContent: '' }),
    accessDetail: /** @type {HTMLElement} */ ({ textContent: '' }),
    accessDisclosure: /** @type {HTMLElement} */ ({ hidden: true }),
    controlCard: /** @type {HTMLElement} */ ({
      classList: {
        toggle(name, active) {
          if (name !== 'attention') {
            return;
          }
          if (active) {
            attention.add(name);
          } else {
            attention.delete(name);
          }
        },
      },
    }),
    button,
  };

  renderPopupViewState(
    {
      tabId: 10,
      windowId: 2,
      title: 'Pending access',
      url: 'https://example.com',
      enabled: false,
      accessRequested: true,
      restricted: false,
    },
    targets
  );

  assert.equal(targets.accessEyebrow.textContent, 'Window access requested');
  assert.match(targets.accessDetail.textContent, /Enable it to allow page inspection/);
  assert.equal(targets.accessDisclosure.hidden, false);
  assert.equal(attention.has('attention'), true);
  assert.equal(button.textContent, 'Enable Window Access');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.pending, 'false');
});

test('renderPopupButtonState resets pending flags for unavailable state', () => {
  const button = /** @type {HTMLButtonElement} */ (
    /** @type {unknown} */ ({
      textContent: 'Enabling…',
      disabled: false,
      dataset: { pending: 'true' },
    })
  );

  renderPopupButtonState(null, button);

  assert.equal(button.textContent, 'Enable Window Access');
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.pending, 'false');
});

test('renderPopupNativeIndicator updates indicator metadata and ignores missing elements', () => {
  const indicator = /** @type {HTMLSpanElement} */ ({
    dataset: {},
    title: '',
    ariaLabel: '',
    setAttribute(name, value) {
      if (name === 'aria-label') {
        this.ariaLabel = value;
      }
    },
  });

  renderPopupNativeIndicator(indicator, false);
  renderPopupNativeIndicator(null, true);

  assert.equal(indicator.dataset.connected, 'false');
  assert.equal(indicator.title, 'Native host disconnected');
  assert.equal(indicator.ariaLabel, 'Native host disconnected');
});

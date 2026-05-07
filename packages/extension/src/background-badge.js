// @ts-check

import { ERROR_CODES } from '../../protocol/src/index.js';
import {
  ACCESS_REQUEST_BADGE_TEXT,
  ENABLED_BADGE_TEXT,
  RESTRICTED_BADGE_TEXT,
  isNumber,
} from './background-state.js';

/** @typedef {import('./background-state.js').ExtensionState} ExtensionState */

/**
 * @typedef {{
 *   isRestrictedAutomationUrl: (url: string) => boolean,
 *   getErrorMessage: (error: unknown) => string,
 *   normalizeRuntimeErrorMessage: (message: string) => string,
 * }} BadgeDependencies
 */

/**
 * @typedef {{
 *   badgeText: string,
 *   backgroundColor: string,
 *   textColor: string,
 *   title: string,
 * }} ActionIndicatorState
 */

/**
 * @param {boolean} enabled
 * @param {boolean} accessRequested
 * @param {boolean} restricted
 * @returns {ActionIndicatorState}
 */
function getActionIndicatorState(enabled, accessRequested, restricted) {
  if (enabled && restricted) {
    return {
      badgeText: RESTRICTED_BADGE_TEXT,
      backgroundColor: '#e07020',
      textColor: '#ffffff',
      title: 'Browser Bridge is enabled, but this page cannot be interacted with.',
    };
  }

  if (enabled) {
    return {
      badgeText: ENABLED_BADGE_TEXT,
      backgroundColor: '#787878',
      textColor: '#ffffff',
      title: 'Browser Bridge is enabled for this window.',
    };
  }

  if (accessRequested) {
    return {
      badgeText: ACCESS_REQUEST_BADGE_TEXT,
      backgroundColor: '#f2cf2f',
      textColor: '#000000',
      title:
        'Agent requested Browser Bridge access for this window. Click to open Browser Bridge, then click Enable.',
    };
  }

  return {
    badgeText: '',
    backgroundColor: '#464646',
    textColor: '#ffffff',
    title: 'Browser Bridge',
  };
}

/**
 * @param {number} tabId
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @returns {Promise<boolean>}
 */
export async function isTabEnabled(tabId, state, chromeObj) {
  if (!state.enabledWindow) {
    return false;
  }
  try {
    const tab = await chromeObj.tabs.get(tabId);
    return tab.windowId === state.enabledWindow.windowId;
  } catch {
    return false;
  }
}

/**
 * @param {number} tabId
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @returns {Promise<boolean>}
 */
export async function isAccessRequestedTab(tabId, state, chromeObj) {
  try {
    const tab = await chromeObj.tabs.get(tabId);
    return typeof tab.windowId === 'number' && tab.windowId === state.requestedAccessWindowId;
  } catch {
    return false;
  }
}

/**
 * Update the action badge and title for one tab so enabled windows are visibly
 * marked from the Chrome toolbar.
 *
 * @param {number} tabId
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @param {BadgeDependencies} dependencies
 * @returns {Promise<void>}
 */
export async function updateActionIndicatorForTab(tabId, state, chromeObj, dependencies) {
  const enabled = await isTabEnabled(tabId, state, chromeObj);
  const accessRequested = !enabled && (await isAccessRequestedTab(tabId, state, chromeObj));
  let restricted = false;
  if (enabled) {
    try {
      const tab = await chromeObj.tabs.get(tabId);
      restricted = dependencies.isRestrictedAutomationUrl(tab.url ?? '');
    } catch {
      /* ignore */
    }
  }

  const indicator = getActionIndicatorState(enabled, accessRequested, restricted);

  try {
    await chromeObj.action.setBadgeBackgroundColor({
      tabId,
      color: indicator.backgroundColor,
    });
  } catch {
    /* color APIs may be unsupported */
  }
  try {
    await chromeObj.action.setBadgeTextColor({ tabId, color: indicator.textColor });
  } catch {
    /* setBadgeTextColor not supported everywhere */
  }
  try {
    await chromeObj.action.setTitle({ tabId, title: indicator.title });
  } catch {
    /* title can fail for closed tabs */
  }
  try {
    await chromeObj.action.setBadgeText({ tabId, text: indicator.badgeText });
  } catch (error) {
    if (
      dependencies.normalizeRuntimeErrorMessage(dependencies.getErrorMessage(error)) ===
      ERROR_CODES.TAB_MISMATCH
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Set the global badge (no tabId) to match the active tab in the last-focused
 * window. This forces browsers that batch per-tab badge updates (e.g. Edge) to
 * immediately repaint the toolbar icon.
 *
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @param {BadgeDependencies} dependencies
 * @returns {Promise<void>}
 */
export async function syncGlobalBadgeToActiveTab(state, chromeObj, dependencies) {
  try {
    const [activeTab] = await chromeObj.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!activeTab?.id) {
      return;
    }

    const enabled = await isTabEnabled(activeTab.id, state, chromeObj);
    const accessRequested =
      !enabled && (await isAccessRequestedTab(activeTab.id, state, chromeObj));
    const restricted = enabled && dependencies.isRestrictedAutomationUrl(activeTab.url ?? '');
    const indicator = getActionIndicatorState(enabled, accessRequested, restricted);

    await chromeObj.action.setBadgeText({ text: indicator.badgeText });
    try {
      await chromeObj.action.setBadgeBackgroundColor({ color: indicator.backgroundColor });
    } catch {
      /* unsupported */
    }
    try {
      await chromeObj.action.setBadgeTextColor({ color: indicator.textColor });
    } catch {
      /* unsupported */
    }
  } catch {
    /* non-critical */
  }
}

/**
 * Refresh the extension action badge and title across the currently open tabs.
 *
 * @param {ExtensionState} state
 * @param {typeof globalThis.chrome} chromeObj
 * @param {BadgeDependencies} dependencies
 * @returns {Promise<void>}
 */
export async function refreshActionIndicators(state, chromeObj, dependencies) {
  const query = state.enabledWindow ? { windowId: state.enabledWindow.windowId } : {};
  const tabs = await chromeObj.tabs.query(query);
  const tabIds = tabs
    .map((tab) => (isNumber(tab.id) ? tab.id : null))
    .filter((tabId) => tabId !== null);
  await Promise.allSettled(
    tabIds.map((tabId) => updateActionIndicatorForTab(tabId, state, chromeObj, dependencies))
  );

  // Some Chromium-based browsers (e.g. Edge) do not visually refresh the toolbar
  // badge after per-tab updates until the tab navigates. Setting the global badge
  // (without tabId) to match the active tab forces an immediate repaint.
  await syncGlobalBadgeToActiveTab(state, chromeObj, dependencies);
}

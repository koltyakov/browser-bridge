// @ts-check

/**
 * @typedef {{
 *   tabId: number,
 *   windowId: number,
 *   title: string,
 *   url: string,
 *   enabled: boolean,
 *   accessRequested: boolean,
 *   restricted: boolean
 * }} PopupCurrentTab
 */

/**
 * @typedef {{
 *   eyebrow: string,
 *   detail: string,
 *   disclosureHidden: boolean,
 *   attention: boolean,
 *   buttonLabel: string,
 *   buttonDisabled: boolean
 * }} PopupViewState
 */

/**
 * @typedef {{
 *   accessEyebrow: Pick<HTMLElement, 'textContent'>,
 *   accessDetail: Pick<HTMLElement, 'textContent'>,
 *   accessDisclosure: Pick<HTMLElement, 'hidden'>,
 *   controlCard?: Pick<HTMLElement, 'classList'> | null,
 *   button: Pick<HTMLButtonElement, 'textContent' | 'disabled'> & { dataset: DOMStringMap }
 * }} PopupRenderTargets
 */

/**
 * @param {PopupCurrentTab | null} currentTab
 * @returns {PopupViewState}
 */
export function getPopupViewState(currentTab) {
  if (!currentTab) {
    return {
      eyebrow: 'Window access unavailable',
      detail: 'Open a normal web page to manage Browser Bridge for this Chrome window.',
      disclosureHidden: false,
      attention: false,
      buttonLabel: 'Enable Window Access',
      buttonDisabled: true,
    };
  }

  if (currentTab.enabled && currentTab.restricted) {
    return {
      eyebrow: 'Window access enabled',
      detail:
        'This page cannot be interacted with. Switch to a normal web page to use Browser Bridge.',
      disclosureHidden: false,
      attention: false,
      buttonLabel: 'Disable Window Access',
      buttonDisabled: !currentTab.url,
    };
  }

  if (currentTab.enabled) {
    return {
      eyebrow: 'Window access enabled',
      detail: 'Your connected agent can inspect and interact with pages in this Chrome window.',
      disclosureHidden: true,
      attention: false,
      buttonLabel: 'Disable Window Access',
      buttonDisabled: !currentTab.url,
    };
  }

  if (currentTab.accessRequested) {
    return {
      eyebrow: 'Window access requested',
      detail:
        'An agent requested access for this Chrome window. Enable it to allow page inspection and interaction.',
      disclosureHidden: false,
      attention: true,
      buttonLabel: 'Enable Window Access',
      buttonDisabled: !currentTab.url,
    };
  }

  return {
    eyebrow: 'Window access',
    detail:
      'Enable Browser Bridge to let your connected agent inspect and interact with pages in this Chrome window.',
    disclosureHidden: false,
    attention: false,
    buttonLabel: 'Enable Window Access',
    buttonDisabled: !currentTab.url,
  };
}

/**
 * @param {PopupCurrentTab | null} currentTab
 * @param {PopupRenderTargets['button']} button
 * @returns {void}
 */
export function renderPopupButtonState(currentTab, button) {
  const viewState = getPopupViewState(currentTab);
  button.dataset.pending = 'false';
  button.textContent = viewState.buttonLabel;
  button.disabled = viewState.buttonDisabled;
}

/**
 * @param {PopupCurrentTab | null} currentTab
 * @param {PopupRenderTargets} targets
 * @returns {void}
 */
export function renderPopupViewState(currentTab, targets) {
  const viewState = getPopupViewState(currentTab);
  renderPopupButtonState(currentTab, targets.button);
  targets.accessEyebrow.textContent = viewState.eyebrow;
  targets.accessDetail.textContent = viewState.detail;
  targets.accessDisclosure.hidden = viewState.disclosureHidden;
  targets.controlCard?.classList.toggle('attention', viewState.attention);
}

/**
 * @param {HTMLSpanElement | null} nativeIndicator
 * @param {boolean} connected
 * @returns {void}
 */
export function renderPopupNativeIndicator(nativeIndicator, connected) {
  if (!nativeIndicator) {
    return;
  }
  const label = connected ? 'Native host connected' : 'Native host disconnected';
  nativeIndicator.dataset.connected = String(connected);
  nativeIndicator.title = label;
  nativeIndicator.setAttribute('aria-label', label);
}

/**
 * @param {boolean} enabled
 * @param {PopupCurrentTab | null} currentTab
 * @param {number | null} popupScopeTabId
 * @returns {{ type: 'scope.set_enabled', enabled: boolean, tabId?: number }}
 */
export function createPopupToggleMessage(enabled, currentTab, popupScopeTabId) {
  const scopedTabId = currentTab?.tabId ?? popupScopeTabId;
  return {
    type: 'scope.set_enabled',
    enabled,
    ...(scopedTabId ? { tabId: scopedTabId } : {}),
  };
}

/**
 * @param {PopupCurrentTab | null} currentTab
 * @param {boolean | null} pendingEnabledState
 * @returns {boolean}
 */
export function shouldResetPendingToggleOnSync(currentTab, pendingEnabledState) {
  return (
    pendingEnabledState != null && currentTab != null && currentTab.enabled === pendingEnabledState
  );
}

/**
 * @param {string} errorMessage
 * @returns {string}
 */
export function normalizePopupToggleError(errorMessage) {
  return errorMessage.replace(/^CONTENT_SCRIPT_UNAVAILABLE:\s*/i, '');
}

/**
 * @param {string} runtimeId
 * @param {string} publishedExtensionId
 * @returns {string}
 */
export function getPopupInstallCommand(runtimeId, publishedExtensionId) {
  return runtimeId === publishedExtensionId ? 'bbx install' : `bbx install ${runtimeId}`;
}

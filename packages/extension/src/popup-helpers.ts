export type PopupCurrentTab = {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  enabled: boolean;
  accessRequested: boolean;
  restricted: boolean;
  accessRequestContext?: import('./background-state.js').AccessRequestContext | null;
};

export type PopupViewState = {
  eyebrow: string;
  detail: string;
  disclosureHidden: boolean;
  attention: boolean;
  buttonLabel: string;
  buttonDisabled: boolean;
};

export type PopupRenderTargets = {
  accessEyebrow: Pick<HTMLElement, 'textContent'>;
  accessDetail: Pick<HTMLElement, 'textContent'>;
  accessDisclosure: Pick<HTMLElement, 'hidden'>;
  controlCard?: Pick<HTMLElement, 'classList'> | null;
  button: Pick<HTMLButtonElement, 'textContent' | 'disabled'> & { dataset: DOMStringMap };
};

export function getPopupViewState(currentTab: PopupCurrentTab | null): PopupViewState {
  if (!currentTab) {
    return {
      eyebrow: 'Window access unavailable',
      detail: 'Open a normal web page to manage Browser Bridge for this browser window.',
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
      detail: 'Your connected agent can inspect and interact with pages in this browser window.',
      disclosureHidden: true,
      attention: false,
      buttonLabel: 'Disable Window Access',
      buttonDisabled: !currentTab.url,
    };
  }

  if (currentTab.accessRequested) {
    const context = currentTab.accessRequestContext;
    const source =
      context?.source === 'mcp'
        ? context.mcpEra === 'modern'
          ? 'MCP Modern'
          : context.mcpEra === 'legacy'
            ? 'MCP Legacy'
            : 'MCP'
        : context?.source === 'cli'
          ? 'CLI'
          : 'A connected agent';
    const intent = context?.intent === 'general' || !context?.intent ? 'use' : context.intent;
    const tab =
      context?.title || context?.origin
        ? ` Current tab: ${context.title || 'Untitled page'}${context.origin ? ` - ${context.origin}` : ''}.`
        : ' Current tab details are unavailable.';
    return {
      eyebrow: 'Window access requested',
      detail: `${source} requested access to ${intent} pages in this browser window.${tab}`,
      disclosureHidden: false,
      attention: true,
      buttonLabel: 'Enable Window Access',
      buttonDisabled: !currentTab.url,
    };
  }

  return {
    eyebrow: 'Window access',
    detail:
      'Enable Browser Bridge to let your connected agent inspect and interact with pages in this browser window.',
    disclosureHidden: false,
    attention: false,
    buttonLabel: 'Enable Window Access',
    buttonDisabled: !currentTab.url,
  };
}

export function renderPopupButtonState(
  currentTab: PopupCurrentTab | null,
  button: PopupRenderTargets['button']
): void {
  const viewState = getPopupViewState(currentTab);
  button.dataset.pending = 'false';
  button.dataset.enabled = String(currentTab?.enabled ?? false);
  button.textContent = viewState.buttonLabel;
  button.disabled = viewState.buttonDisabled;
}

export function renderPopupViewState(
  currentTab: PopupCurrentTab | null,
  targets: PopupRenderTargets
): void {
  const viewState = getPopupViewState(currentTab);
  renderPopupButtonState(currentTab, targets.button);
  targets.accessEyebrow.textContent = viewState.eyebrow;
  targets.accessDetail.textContent = viewState.detail;
  targets.accessDisclosure.hidden = viewState.disclosureHidden;
  targets.controlCard?.classList.toggle('attention', viewState.attention);
}

export function renderPopupNativeIndicator(
  nativeIndicator: HTMLSpanElement | null,
  connected: boolean
): void {
  if (!nativeIndicator) {
    return;
  }
  const label = connected ? 'Native host connected' : 'Native host disconnected';
  nativeIndicator.dataset.connected = String(connected);
  nativeIndicator.title = label;
  nativeIndicator.setAttribute('aria-label', label);
}

export function createPopupToggleMessage(
  enabled: boolean,
  currentTab: PopupCurrentTab | null,
  popupScopeTabId: number | null
): { type: 'scope.set_enabled'; enabled: boolean; tabId?: number } {
  const scopedTabId = currentTab?.tabId ?? popupScopeTabId;
  return {
    type: 'scope.set_enabled',
    enabled,
    ...(scopedTabId ? { tabId: scopedTabId } : {}),
  };
}

export function shouldResetPendingToggleOnSync(
  currentTab: PopupCurrentTab | null,
  pendingEnabledState: boolean | null
): boolean {
  return (
    pendingEnabledState != null && currentTab != null && currentTab.enabled === pendingEnabledState
  );
}

export function normalizePopupToggleError(errorMessage: string): string {
  return errorMessage.replace(/^CONTENT_SCRIPT_UNAVAILABLE:\s*/i, '');
}

export function getPopupInstallCommand(runtimeId: string, publishedExtensionId: string): string {
  return runtimeId === publishedExtensionId ? 'bbx install' : `bbx install ${runtimeId}`;
}

/** Diagnostic shown when the native host connection keeps dropping and
reconnecting (crash-looping daemon) instead of being merely offline. */
export function getUnstableConnectionDiagnostic(): string {
  return 'Connection to the local host keeps dropping - the bridge daemon appears to be restarting repeatedly. Run `bbx doctor` in a terminal for the cause and fix steps.';
}

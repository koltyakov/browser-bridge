export type AccessSettings = import('../../../protocol/src/types.js').AccessSettings;

export function getAccessSettingsSnapshot(state: {
  accessSettings?: AccessSettings;
  accessSettingsRevision?: string;
}): import('../../../protocol/src/types.js').AccessSettingsSnapshot {
  return {
    settings: { ...(state.accessSettings ?? DEFAULT_ACCESS_SETTINGS) },
    settingsRevision: state.accessSettingsRevision ?? 'unknown',
  };
}

export function getAccessPolicyDenial(
  state: Parameters<typeof getAccessSettingsSnapshot>[0],
  setting: keyof AccessSettings
): Record<string, unknown> {
  return {
    reason: 'policy_setting_disabled',
    setting,
    dispatched: false,
    ...getAccessSettingsSnapshot(state),
  };
}

export function isNavigationAllowed(
  currentUrl: string,
  destinationUrl: string,
  allowOffDomainNavigation: boolean
): boolean {
  const current = new URL(currentUrl);
  const destination = new URL(destinationUrl);
  // A blank tab has no hostname yet. Ports and schemes do not change domains.
  return allowOffDomainNavigation || !current.hostname || current.hostname === destination.hostname;
}

export const DEFAULT_ACCESS_SETTINGS: Readonly<AccessSettings> = Object.freeze({
  allowCreatingTabs: true,
  allowClosingUserTabs: false,
  closeAiTabsWhenDone: true,
  allowOffDomainNavigation: false,
  allowResponseBodyReads: false,
  allowIndexedDBReads: false,
});

export function normalizeAccessSettings(value: unknown): AccessSettings {
  const candidate = value && typeof value === 'object' ? value : {};
  const result = { ...DEFAULT_ACCESS_SETTINGS };
  for (const key of Object.keys(result) as Array<keyof AccessSettings>) {
    const setting: unknown = Reflect.get(candidate, key);
    if (typeof setting === 'boolean') result[key] = setting;
  }
  return result;
}

export function sensitiveReadSetting(
  source: import('../../../protocol/src/types.js').SensitiveGatedSource
) {
  return ({ response_body: 'allowResponseBodyReads', indexeddb: 'allowIndexedDBReads' } as const)[
    source
  ];
}

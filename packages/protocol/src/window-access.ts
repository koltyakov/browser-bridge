/** Window access metadata shared by the native relay and extension UI. */
export type EnabledWindowInfo = {
  windowId: number;
  title: string;
  enabledAt: number;
};

export type BrowserWindowAccess = {
  extensionId: string;
  browserName: string | null;
  profileLabel: string | null;
  window: EnabledWindowInfo | null;
  canControl?: boolean;
};

/** Local extension UI actions. These are not agent RPC methods. */
export type WindowAction = 'focus' | 'disable';

export type WindowActionCommand = {
  requestId: string;
  action: WindowAction;
  windowId: number;
  enabledAt: number;
};

export type WindowActionRequest = WindowActionCommand & { extensionId: string };

export type WindowActionResult = { requestId: string; ok: boolean; error?: string };
export type WindowActionUiResult = { action: WindowAction; ok: boolean; error?: string };

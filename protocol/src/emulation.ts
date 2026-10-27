import { BridgeError, ERROR_CODES } from './errors.js';

export type EmulationConfig = import('./workflows.js').EmulationConfig;

/** Metrics presets deliberately do not impersonate a different browser engine. */
export const DEVICE_PRESETS = Object.freeze({
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false },
});

export const NETWORK_PRESETS = Object.freeze({
  offline: { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  'slow-3g': { offline: false, latencyMs: 2000, downloadKbps: 400, uploadKbps: 400 },
  'fast-3g': { offline: false, latencyMs: 563, downloadKbps: 1440, uploadKbps: 675 },
  wifi: { offline: false, latencyMs: 2, downloadKbps: 30000, uploadKbps: 15000 },
  unthrottled: { offline: false, latencyMs: 0, downloadKbps: -1, uploadKbps: -1 },
});

export function invalidWorkflow(message: string): never {
  throw new BridgeError(ERROR_CODES.INVALID_REQUEST, message);
}

export function objectParam(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidWorkflow(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function numberParam(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalidWorkflow(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

export function stringParam(value: unknown, name: string, max: number = 256): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    invalidWorkflow(
      `${name} must be a nonempty string of at most ${max} characters without control characters.`
    );
  }
  return value;
}

export function booleanParam(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalidWorkflow(`${name} must be boolean.`);
  return value;
}

export function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) invalidWorkflow(`Unknown parameter: ${unknown}.`);
}

/** Validate once at the shared boundary; repeated normalization is idempotent. */
export function normalizeEmulation(params: Record<string, unknown>): EmulationConfig {
  onlyKeys(params, ['device', 'network', 'cpuRate', 'locale', 'timezoneId', 'geolocation']);

  const config: EmulationConfig = {};
  if (params.device !== undefined) {
    const input =
      typeof params.device === 'string'
        ? { preset: params.device }
        : objectParam(params.device, 'device');
    onlyKeys(input, ['preset', 'width', 'height', 'deviceScaleFactor', 'mobile', 'touch']);
    const preset =
      input.preset === undefined
        ? {}
        : Object.hasOwn(DEVICE_PRESETS, String(input.preset))
          ? DEVICE_PRESETS[input.preset as keyof typeof DEVICE_PRESETS]
          : null;
    if (!preset) invalidWorkflow('device.preset must be phone, tablet, or desktop.');

    const device: Record<string, unknown> = { ...preset, ...input };
    config.device = {
      width: Math.round(numberParam(device.width, 'width', 1, 8192)),
      height: Math.round(numberParam(device.height, 'height', 1, 8192)),
      deviceScaleFactor: numberParam(device.deviceScaleFactor ?? 1, 'deviceScaleFactor', 0.1, 4),
      mobile: booleanParam(device.mobile ?? false, 'mobile'),
      touch: booleanParam(device.touch ?? device.mobile ?? false, 'touch'),
    };
  }
  if (params.network !== undefined) {
    const input =
      typeof params.network === 'string'
        ? { preset: params.network }
        : objectParam(params.network, 'network');
    onlyKeys(input, ['preset', 'offline', 'latencyMs', 'downloadKbps', 'uploadKbps']);
    const preset =
      input.preset === undefined
        ? NETWORK_PRESETS.unthrottled
        : Object.hasOwn(NETWORK_PRESETS, String(input.preset))
          ? NETWORK_PRESETS[input.preset as keyof typeof NETWORK_PRESETS]
          : null;
    if (!preset)
      invalidWorkflow(
        'Unknown network preset. Use offline, slow-3g, fast-3g, wifi, or unthrottled.'
      );
    const network = { ...preset, ...input };
    config.network = {
      offline: booleanParam(network.offline, 'offline'),
      latencyMs: numberParam(network.latencyMs, 'latencyMs', 0, 60000),
      downloadKbps: numberParam(network.downloadKbps, 'downloadKbps', -1, 10000000),
      uploadKbps: numberParam(network.uploadKbps, 'uploadKbps', -1, 10000000),
    };
    for (const speed of [config.network.downloadKbps, config.network.uploadKbps]) {
      if (speed < 0 && speed !== -1)
        invalidWorkflow('Throughput must be nonnegative or -1 for unthrottled.');
    }
  }
  if (params.cpuRate !== undefined) config.cpuRate = numberParam(params.cpuRate, 'cpuRate', 1, 100);
  if (params.locale !== undefined) {
    config.locale = stringParam(params.locale, 'locale', 80);
    try {
      Intl.getCanonicalLocales(config.locale);
    } catch {
      invalidWorkflow('Invalid locale.');
    }
  }
  if (params.timezoneId !== undefined) {
    config.timezoneId = stringParam(params.timezoneId, 'timezoneId', 100);
    try {
      new Intl.DateTimeFormat('en', { timeZone: config.timezoneId });
    } catch {
      invalidWorkflow('Invalid timezoneId.');
    }
  }
  if (params.geolocation !== undefined) {
    const geo = objectParam(params.geolocation, 'geolocation');
    onlyKeys(geo, ['latitude', 'longitude', 'accuracy']);
    config.geolocation = {
      latitude: numberParam(geo.latitude, 'latitude', -90, 90),
      longitude: numberParam(geo.longitude, 'longitude', -180, 180),
      accuracy: numberParam(geo.accuracy ?? 100, 'accuracy', 0, 1000000),
    };
  }
  if (!Object.keys(config).length) invalidWorkflow('Provide at least one emulation setting.');
  return config;
}

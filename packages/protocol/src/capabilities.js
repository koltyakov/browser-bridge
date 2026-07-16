// @ts-check

import { CAPABILITIES, DEFAULT_CAPABILITIES } from './capability-values.js';
import { BRIDGE_METHODS, BRIDGE_METHOD_REGISTRY } from './registry.js';

/** @typedef {import('./types.js').BridgeMethod} CapabilityMethod */
/** @typedef {import('./types.js').Capability} Capability */

export { CAPABILITIES, DEFAULT_CAPABILITIES };

/** @type {readonly CapabilityMethod[]} */
const LEGACY_METHOD_CAPABILITY_PREFIX = [
  'access.request',
  'tabs.list',
  'tabs.create',
  'tabs.close',
  'tabs.activate',
  'skill.get_runtime_context',
  'setup.get_status',
  'setup.install',
];

/** @type {readonly CapabilityMethod[]} */
const LEGACY_METHOD_CAPABILITY_SUFFIX = ['log.tail', 'health.ping', 'daemon.metrics'];

const LEGACY_POSITIONED_METHODS = new Set([
  ...LEGACY_METHOD_CAPABILITY_PREFIX,
  ...LEGACY_METHOD_CAPABILITY_SUFFIX,
]);

/** @type {Readonly<Record<CapabilityMethod, Capability | null>>} */
export const METHOD_CAPABILITIES = Object.freeze(
  /** @type {Record<CapabilityMethod, Capability | null>} */ (
    Object.fromEntries(
      [
        ...LEGACY_METHOD_CAPABILITY_PREFIX,
        ...BRIDGE_METHODS.filter((method) => !LEGACY_POSITIONED_METHODS.has(method)),
        ...LEGACY_METHOD_CAPABILITY_SUFFIX,
      ].map((method) => [method, BRIDGE_METHOD_REGISTRY[method].capability])
    )
  )
);

/**
 * @param {unknown} value
 * @returns {value is Capability}
 */
export function isCapability(value) {
  return /** @type {string[]} */ (Object.values(CAPABILITIES)).includes(
    /** @type {string} */ (value)
  );
}

/**
 * Return the legacy capability bucket associated with one bridge method.
 * A `null` value means the method is global/system-scoped and does not map to
 * a former capability gate.
 *
 * @param {CapabilityMethod} method
 * @returns {Capability | null}
 */
export function getMethodCapability(method) {
  return METHOD_CAPABILITIES[method] ?? null;
}

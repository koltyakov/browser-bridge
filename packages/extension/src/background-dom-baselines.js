// @ts-check

import {
  BridgeError,
  DOM_BASELINE_TTL_MS,
  ERROR_CODES,
  MAX_DOM_BASELINE_BYTES,
  MAX_DOM_BASELINE_BYTES_GLOBAL as MAX_DOM_BASELINE_TOTAL_BYTES,
  MAX_DOM_BASELINE_BYTES_PER_TAB as MAX_DOM_BASELINE_TAB_BYTES,
  MAX_DOM_BASELINES_GLOBAL,
  MAX_DOM_BASELINES_PER_TAB,
} from '../../protocol/src/index.js';

const BASELINE_ID_PATTERN = /^baseline_[A-Za-z0-9_-]{32,64}$/u;
const DEFAULT_MAX_CHANGES = 50;
const AMBIGUITY_EXAMPLE_LIMIT = 5;
const encoder = new TextEncoder();

/** @typedef {'DOM_BASELINE_NOT_FOUND' | 'DOM_BASELINE_INVALIDATED' | 'DOM_BASELINE_QUOTA_EXCEEDED'} DomBaselineErrorCode */

/**
 * @typedef {Record<string, unknown> & {
 *   nodeId: string | number,
 *   parentId?: string | number | null,
 *   parentNodeId?: string | number | null,
 *   siblingIndex?: number,
 *   index?: number,
 *   tag?: unknown,
 *   tagName?: unknown,
 *   role?: unknown,
 *   roleFingerprint?: unknown,
 *   name?: unknown,
 *   nameFingerprint?: unknown,
 *   text?: unknown,
 *   textFingerprint?: unknown,
 *   attrs?: unknown,
 *   attrsFingerprint?: unknown,
 *   attributesFingerprint?: unknown,
 *   state?: unknown,
 *   stateFingerprint?: unknown,
 * }} DomBaselineNode
 */

/**
 * @typedef {Record<string, unknown> & {
 *   documentToken?: string,
 *   representation?: string,
 *   selector?: string | null,
 *   scope?: { documentToken?: string, representation?: string, selector?: string | null },
 *   nodes: DomBaselineNode[],
 *   stats?: { nodeCount?: number, byteLength?: number, digest?: string },
 * }} DomBaselineSnapshot
 */

/**
 * @typedef {{
 *   windowId: number,
 *   tabId: number,
 *   frameId: number,
 *   selector: string | null,
 *   options: Record<string, unknown>,
 *   snapshot: DomBaselineSnapshot,
 *   now?: number,
 * }} CreateBaselineInput
 */

/**
 * @typedef {{
 *   windowId: number,
 *   tabId: number,
 *   frameId: number,
 *   selector: string | null,
 *   documentToken: string,
 *   representation: string,
 * }} BaselineScope
 */

/**
 * @typedef {{
 *   baselineId: string,
 *   createdAt: string,
 *   expiresAt: string,
 *   scope: BaselineScope,
 *   options: Record<string, unknown>,
 *   snapshot: { nodeCount: number, byteLength: number, digest: string },
 *   evicted?: Array<{ baselineId: string, reason: string }>,
 * }} BaselineDescriptor
 */

/**
 * @typedef {{
 *   descriptor: Readonly<BaselineDescriptor>,
 *   snapshot: Readonly<DomBaselineSnapshot>,
 *   bytes: number,
 *   createdAtMs: number,
 *   expiresAtMs: number,
 *   sequence: number,
 * }} BaselineRecord
 */

/**
 * @typedef {{ calls: number, totalLatencyMs: number, maxLatencyMs: number }} OperationMetric
 */

/**
 * @typedef {{
 *   id: string,
 *   parentId: string | null,
 *   siblingIndex: number,
 *   sourceIndex: number,
 *   tag: unknown,
 *   role: unknown,
 *   name: unknown,
 *   text: unknown,
 *   attrs: unknown,
 *   state: unknown,
 *   displayName: string | null,
 *   textExcerpt: string,
 *   attributes: Record<string, string>,
 *   depth: number,
 *   ancestry: string[],
 *   order: number,
 * }} NormalizedNode
 */

/**
 * @typedef {{
 *   tag: string,
 *   role: string | null,
 *   name: string | null,
 *   text: string,
 *   attributes: Record<string, string>,
 *   depth: number,
 * }} NodeEvidence
 */

/**
 * @typedef {{ before: NodeEvidence, after: NodeEvidence, fields: string[] }} ChangedEvidence
 */

/**
 * @typedef {{ node: NodeEvidence, from: { ancestry: string[], order: number }, to: { ancestry: string[], order: number } }} MovedEvidence
 */

/** @extends {BridgeError} */
export class DomBaselineError extends BridgeError {
  /**
   * @param {DomBaselineErrorCode} code
   * @param {string} message
   * @param {unknown} [details=null]
   */
  constructor(code, message, details = null) {
    super(code, message, details);
    this.name = 'DomBaselineError';
  }
}

/**
 * Create an in-memory semantic baseline controller. Snapshot records are kept
 * in this closure and are never attached to the application document.
 *
 * @param {{
 *   now?: () => number,
 *   createId?: () => string,
 *   measureNow?: () => number,
 * }} [deps]
 */
export function createDomBaselineController(deps = {}) {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  const measureNow = deps.measureNow ?? (() => performance.now());
  /** @type {Map<string, BaselineRecord>} */
  const records = new Map();
  /** @type {Map<string, { reason: string, expiresAtMs: number, tabId: number, windowId: number }>} */
  const invalidatedRecords = new Map();
  /** @type {Map<string, OperationMetric>} */
  const operationMetrics = new Map();
  /** @type {Map<number, number>} */
  const navigationGenerations = new Map();
  let sequence = 0;
  let totalBytes = 0;
  let lifecycleGeneration = 0;
  let navigationGeneration = 0;

  /** @param {number} tabId */
  function getScopeGeneration(tabId) {
    let generation = navigationGenerations.get(tabId);
    if (generation === undefined) {
      generation = ++navigationGeneration;
      navigationGenerations.set(tabId, generation);
      boundNavigationGenerations();
    }
    return `${lifecycleGeneration}:${generation}`;
  }

  /** @param {number} tabId */
  function advanceTabGeneration(tabId) {
    navigationGenerations.delete(tabId);
    navigationGenerations.set(tabId, ++navigationGeneration);
    boundNavigationGenerations();
  }

  function boundNavigationGenerations() {
    while (navigationGenerations.size > 256) {
      const oldestTabId = navigationGenerations.keys().next().value;
      if (typeof oldestTabId !== 'number') break;
      navigationGenerations.delete(oldestTabId);
    }
  }

  /**
   * @template T
   * @param {string} operation
   * @param {() => T} action
   * @returns {T}
   */
  function measured(operation, action) {
    const startedAt = measureNow();
    try {
      return action();
    } finally {
      const latency = Math.max(0, measureNow() - startedAt);
      const metric = operationMetrics.get(operation) ?? {
        calls: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
      };
      metric.calls += 1;
      metric.totalLatencyMs += latency;
      metric.maxLatencyMs = Math.max(metric.maxLatencyMs, latency);
      operationMetrics.set(operation, metric);
    }
  }

  /**
   * @param {CreateBaselineInput} input
   * @returns {Readonly<BaselineDescriptor>}
   */
  function create(input) {
    return measured('create', () => {
      assertFiniteInteger(input.windowId, 'windowId');
      assertFiniteInteger(input.tabId, 'tabId');
      assertFiniteInteger(input.frameId, 'frameId');
      if (input.selector !== null && typeof input.selector !== 'string') {
        throw new TypeError('selector must be a string or null.');
      }

      const createdAt = input.now ?? now();
      if (!Number.isFinite(createdAt)) throw new TypeError('now must be finite.');
      pruneExpiredInternal(createdAt);
      const { clone: snapshot, bytes } = cloneJson(input.snapshot, 'snapshot');
      const { clone: options } = cloneJson(input.options, 'options');
      const scope = readSnapshotScope(snapshot);
      if (scope.selector !== input.selector) {
        throw new DomBaselineError(
          ERROR_CODES.DOM_BASELINE_INVALIDATED,
          'Snapshot selector does not match the requested baseline selector.',
          { reason: 'selector_mismatch' }
        );
      }
      validateSnapshot(snapshot);
      if (bytes > MAX_DOM_BASELINE_BYTES) {
        throw new DomBaselineError(
          ERROR_CODES.DOM_BASELINE_QUOTA_EXCEEDED,
          `DOM baseline snapshot exceeds the ${MAX_DOM_BASELINE_BYTES} byte limit.`,
          { bytes, maxBytes: MAX_DOM_BASELINE_BYTES }
        );
      }

      /** @type {Array<{ baselineId: string, reason: string }>} */
      const evicted = [];
      evictForTab(input.tabId, bytes, evicted);
      evictGlobally(bytes, evicted);
      if (bytes > MAX_DOM_BASELINE_TAB_BYTES || totalBytes + bytes > MAX_DOM_BASELINE_TOTAL_BYTES) {
        throw new DomBaselineError(
          ERROR_CODES.DOM_BASELINE_QUOTA_EXCEEDED,
          'DOM baseline storage quota was exceeded.',
          {
            bytes,
            tabMaxBytes: MAX_DOM_BASELINE_TAB_BYTES,
            totalMaxBytes: MAX_DOM_BASELINE_TOTAL_BYTES,
          }
        );
      }

      const baselineId = nextBaselineId();
      const snapshotStats = deepFreeze({
        nodeCount: snapshot.nodes.length,
        byteLength: bytes,
        digest: typeof snapshot.stats?.digest === 'string' ? snapshot.stats.digest : '',
      });
      /** @type {BaselineDescriptor} */
      const descriptorValue = {
        baselineId,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(createdAt + DOM_BASELINE_TTL_MS).toISOString(),
        scope: {
          windowId: input.windowId,
          tabId: input.tabId,
          frameId: input.frameId,
          selector: input.selector,
          documentToken: scope.documentToken,
          representation: scope.representation,
        },
        options,
        snapshot: snapshotStats,
      };
      if (evicted.length > 0) descriptorValue.evicted = evicted;
      const descriptor = deepFreeze(descriptorValue);
      const record = {
        descriptor,
        snapshot: deepFreeze(snapshot),
        bytes,
        createdAtMs: createdAt,
        expiresAtMs: createdAt + DOM_BASELINE_TTL_MS,
        sequence: sequence++,
      };
      records.set(baselineId, record);
      totalBytes += bytes;
      return descriptor;
    });
  }

  /**
   * @param {string} baselineId
   * @returns {Readonly<BaselineDescriptor>}
   */
  function get(baselineId) {
    return measured('get', () => getRecord(baselineId, now()).descriptor);
  }

  /**
   * Compare without changing the baseline record or its expiration deadline.
   *
   * @param {string} baselineId
   * @param {DomBaselineSnapshot} currentSnapshot
   * @param {number} [maxChanges=DEFAULT_MAX_CHANGES]
   */
  function compare(baselineId, currentSnapshot, maxChanges = DEFAULT_MAX_CHANGES) {
    return measured('compare', () => {
      const comparedAt = now();
      const record = getRecord(baselineId, comparedAt);
      validateSnapshot(currentSnapshot);
      const currentScope = readSnapshotScope(currentSnapshot);
      assertSameScope(record.descriptor.scope, currentScope);
      const limit = normalizeMaxChanges(maxChanges);
      const beforeNodes = normalizeNodes(record.snapshot.nodes);
      const afterNodes = normalizeNodes(currentSnapshot.nodes);
      const beforeById = new Map(beforeNodes.map((node) => [node.id, node]));
      const afterById = new Map(afterNodes.map((node) => [node.id, node]));
      const added = afterNodes.filter((node) => !beforeById.has(node.id));
      const removed = beforeNodes.filter((node) => !afterById.has(node.id));
      /** @type {ChangedEvidence[]} */
      const changed = [];
      const changedIds = new Set();
      /** @type {NormalizedNode[]} */
      const unchanged = [];

      for (const before of beforeNodes) {
        const after = afterById.get(before.id);
        if (!after) continue;
        const fields = changedFields(before, after);
        if (fields.length > 0) {
          changedIds.add(before.id);
          changed.push({
            before: toEvidence(before),
            after: toEvidence(after),
            fields,
          });
        } else {
          unchanged.push(before);
        }
      }

      const movedIds = findMovedRoots(beforeNodes, afterNodes, afterById);
      /** @type {MovedEvidence[]} */
      const moved = [];
      for (const node of afterNodes) {
        if (!movedIds.has(node.id)) continue;
        const before = beforeById.get(node.id);
        if (before) {
          moved.push({
            node: toEvidence(node),
            from: { ancestry: before.ancestry, order: before.order },
            to: { ancestry: node.ancestry, order: node.order },
          });
        }
      }

      const addedEvidence = added.map(toEvidence);
      const removedEvidence = removed.map(toEvidence);
      let remaining = limit;
      const boundedAdded = takeBounded(addedEvidence, remaining);
      remaining -= boundedAdded.length;
      const boundedRemoved = takeBounded(removedEvidence, remaining);
      remaining -= boundedRemoved.length;
      const boundedChanged = takeBounded(changed, remaining);
      remaining -= boundedChanged.length;
      const boundedMoved = takeBounded(moved, remaining);
      remaining -= boundedMoved.length;
      const omittedCount =
        added.length +
        removed.length +
        changed.length +
        moved.length -
        boundedAdded.length -
        boundedRemoved.length -
        boundedChanged.length -
        boundedMoved.length;
      const ambiguity = findAmbiguities(removed, added);
      const ambiguityExamples = ambiguity.examples.slice(
        0,
        Math.min(AMBIGUITY_EXAMPLE_LIMIT, remaining)
      );
      const changedOrMoved = new Set([...changedIds, ...movedIds]);
      const unchangedCount = unchanged.filter((node) => !changedOrMoved.has(node.id)).length;
      const totalIds = new Set([...beforeById.keys(), ...afterById.keys()]).size;
      const guidance = [];
      if (omittedCount > 0) {
        guidance.push('Narrow the selector or increase maxChanges to return more change evidence.');
      }
      if (ambiguity.count > 0) {
        guidance.push(
          'Use a narrower selector or stable distinguishing attributes to disambiguate replacements.'
        );
      }

      return deepFreeze({
        baselineId,
        equal: added.length + removed.length + changed.length + moved.length === 0,
        comparedAt: new Date(comparedAt).toISOString(),
        counts: {
          added: added.length,
          removed: removed.length,
          changed: changed.length,
          moved: moved.length,
          unchanged: unchangedCount,
          total: totalIds,
        },
        returnedCounts: {
          added: boundedAdded.length,
          removed: boundedRemoved.length,
          changed: boundedChanged.length,
          moved: boundedMoved.length,
          total:
            boundedAdded.length +
            boundedRemoved.length +
            boundedChanged.length +
            boundedMoved.length,
        },
        added: boundedAdded,
        removed: boundedRemoved,
        changed: boundedChanged,
        moved: boundedMoved,
        truncated: omittedCount > 0,
        omittedChanges: omittedCount,
        ambiguity: {
          count: ambiguity.count,
          examples: ambiguityExamples,
        },
        guidance: guidance.join(' '),
      });
    });
  }

  /** @param {string} baselineId */
  function release(baselineId) {
    return measured('release', () => {
      const released = removeRecord(baselineId) !== null;
      invalidatedRecords.delete(baselineId);
      return { baselineId, released };
    });
  }

  /** @param {string} baselineId @param {string} [reason='explicit'] */
  function invalidate(baselineId, reason = 'explicit') {
    return measured('invalidate', () => ({
      invalidated: invalidateRecord(baselineId, reason),
      reason,
    }));
  }

  /** @param {number} tabId */
  function clearTab(tabId) {
    return measured('clearTab', () => {
      advanceTabGeneration(tabId);
      for (const [baselineId, record] of invalidatedRecords) {
        if (record.tabId === tabId) invalidatedRecords.delete(baselineId);
      }
      return clearMatching((record) => record.descriptor.scope.tabId === tabId);
    });
  }

  /** @param {number} windowId */
  function clearWindow(windowId) {
    return measured('clearWindow', () => {
      lifecycleGeneration += 1;
      for (const [baselineId, record] of invalidatedRecords) {
        if (record.windowId === windowId) invalidatedRecords.delete(baselineId);
      }
      return clearMatching((record) => record.descriptor.scope.windowId === windowId);
    });
  }

  function clearAll() {
    return measured('clearAll', () => {
      lifecycleGeneration += 1;
      navigationGenerations.clear();
      invalidatedRecords.clear();
      return clearMatching(() => true);
    });
  }

  /** @param {number} tabId */
  function invalidateNavigation(tabId) {
    return measured('invalidateNavigation', () => {
      advanceTabGeneration(tabId);
      let count = 0;
      let bytes = 0;
      for (const [baselineId, record] of [...records]) {
        if (record.descriptor.scope.tabId !== tabId) continue;
        count += 1;
        bytes += record.bytes;
        invalidateRecord(baselineId, 'navigation');
      }
      return { count, bytes };
    });
  }

  function pruneExpired() {
    return measured('pruneExpired', () => pruneExpiredInternal(now()));
  }

  function metrics() {
    return measured('metrics', () => {
      const tabIds = new Set();
      for (const record of records.values()) tabIds.add(record.descriptor.scope.tabId);
      /** @type {Record<string, OperationMetric>} */
      const operations = {};
      for (const [name, metric] of operationMetrics) operations[name] = { ...metric };
      return deepFreeze({
        baselineCount: records.size,
        bytes: totalBytes,
        tabCount: tabIds.size,
        operations,
      });
    });
  }

  /** @param {string} baselineId @param {number} at */
  function getRecord(baselineId, at) {
    const invalidated = invalidatedRecords.get(baselineId);
    if (invalidated) {
      if (invalidated.expiresAtMs <= at) invalidatedRecords.delete(baselineId);
      else {
        throw new DomBaselineError(
          ERROR_CODES.DOM_BASELINE_INVALIDATED,
          'DOM baseline was invalidated by navigation or document replacement.',
          { baselineId, reason: invalidated.reason }
        );
      }
    }
    const record = records.get(baselineId);
    if (!record) {
      throw new DomBaselineError(
        ERROR_CODES.DOM_BASELINE_NOT_FOUND,
        'DOM baseline was not found.',
        {
          baselineId,
          reason: 'missing',
        }
      );
    }
    if (record.expiresAtMs <= at) {
      removeRecord(baselineId);
      throw new DomBaselineError(ERROR_CODES.DOM_BASELINE_NOT_FOUND, 'DOM baseline has expired.', {
        baselineId,
        reason: 'expired',
        expiredAt: record.descriptor.expiresAt,
      });
    }
    return record;
  }

  /** @param {string} baselineId */
  function removeRecord(baselineId) {
    const record = records.get(baselineId) ?? null;
    if (record) {
      records.delete(baselineId);
      totalBytes -= record.bytes;
    }
    return record;
  }

  /** @param {string} baselineId @param {string} reason */
  function invalidateRecord(baselineId, reason) {
    const record = removeRecord(baselineId);
    if (!record) return false;
    invalidatedRecords.delete(baselineId);
    invalidatedRecords.set(baselineId, {
      reason,
      expiresAtMs: record.expiresAtMs,
      tabId: record.descriptor.scope.tabId,
      windowId: record.descriptor.scope.windowId,
    });
    while (invalidatedRecords.size > MAX_DOM_BASELINES_GLOBAL) {
      const oldestId = invalidatedRecords.keys().next().value;
      if (typeof oldestId !== 'string') break;
      invalidatedRecords.delete(oldestId);
    }
    return true;
  }

  /** @param {(record: BaselineRecord) => boolean} predicate */
  function clearMatching(predicate) {
    let count = 0;
    let bytes = 0;
    for (const [baselineId, record] of records) {
      if (!predicate(record)) continue;
      records.delete(baselineId);
      totalBytes -= record.bytes;
      count += 1;
      bytes += record.bytes;
    }
    return { count, bytes };
  }

  /** @param {number} at */
  function pruneExpiredInternal(at) {
    for (const [baselineId, record] of invalidatedRecords) {
      if (record.expiresAtMs <= at) invalidatedRecords.delete(baselineId);
    }
    return clearMatching((record) => record.expiresAtMs <= at);
  }

  /**
   * @param {number} tabId
   * @param {number} incomingBytes
   * @param {Array<{ baselineId: string, reason: string }>} evicted
   */
  function evictForTab(tabId, incomingBytes, evicted) {
    let sameTab = oldestRecords((record) => record.descriptor.scope.tabId === tabId);
    let tabBytes = sameTab.reduce((sum, record) => sum + record.bytes, 0);
    while (
      sameTab.length >= MAX_DOM_BASELINES_PER_TAB ||
      tabBytes + incomingBytes > MAX_DOM_BASELINE_TAB_BYTES
    ) {
      const record = sameTab.shift();
      if (!record) break;
      removeRecord(record.descriptor.baselineId);
      tabBytes -= record.bytes;
      evicted.push({ baselineId: record.descriptor.baselineId, reason: 'per_tab_quota' });
    }
  }

  /**
   * @param {number} incomingBytes
   * @param {Array<{ baselineId: string, reason: string }>} evicted
   */
  function evictGlobally(incomingBytes, evicted) {
    const oldest = oldestRecords(() => true);
    while (
      oldest.length > 0 &&
      (records.size >= MAX_DOM_BASELINES_GLOBAL ||
        totalBytes + incomingBytes > MAX_DOM_BASELINE_TOTAL_BYTES)
    ) {
      const record = oldest.shift();
      if (!record) break;
      removeRecord(record.descriptor.baselineId);
      evicted.push({ baselineId: record.descriptor.baselineId, reason: 'global_quota' });
    }
  }

  /** @param {(record: BaselineRecord) => boolean} predicate */
  function oldestRecords(predicate) {
    return [...records.values()]
      .filter(predicate)
      .sort(
        (left, right) => left.createdAtMs - right.createdAtMs || left.sequence - right.sequence
      );
  }

  function nextBaselineId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generated = createId();
      const baselineId = generated.startsWith('baseline_') ? generated : `baseline_${generated}`;
      if (!BASELINE_ID_PATTERN.test(baselineId)) {
        throw new TypeError('Generated baseline ID must contain 32 to 64 URL-safe characters.');
      }
      if (!records.has(baselineId)) return baselineId;
    }
    throw new Error('Could not allocate a unique DOM baseline ID.');
  }

  return Object.freeze({
    create,
    get,
    describe: get,
    compare,
    release,
    invalidate,
    clearTab,
    clearWindow,
    clearAll,
    getScopeGeneration,
    invalidateNavigation,
    pruneExpired,
    metrics,
  });
}

/** @param {DomBaselineSnapshot} snapshot */
function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.nodes)) {
    throw new TypeError('snapshot.nodes must be an array.');
  }
  readSnapshotScope(snapshot);
  const ids = new Set();
  for (const node of snapshot.nodes) {
    if (!node || typeof node !== 'object') throw new TypeError('Snapshot nodes must be objects.');
    const nodeId = normalizeNodeId(node.nodeId);
    if (ids.has(nodeId)) throw new TypeError(`Snapshot nodeId must be unique: ${nodeId}`);
    ids.add(nodeId);
  }
}

/** @param {DomBaselineSnapshot} snapshot */
function readSnapshotScope(snapshot) {
  const documentToken = snapshot.documentToken ?? snapshot.scope?.documentToken;
  const representation = snapshot.representation ?? snapshot.scope?.representation;
  const selector = snapshot.selector ?? snapshot.scope?.selector ?? null;
  if (typeof documentToken !== 'string' || documentToken.length === 0) {
    throw new TypeError('snapshot documentToken must be a non-empty string.');
  }
  if (typeof representation !== 'string' || representation.length === 0) {
    throw new TypeError('snapshot representation must be a non-empty string.');
  }
  if (selector !== null && typeof selector !== 'string') {
    throw new TypeError('snapshot selector must be a string or null.');
  }
  return { documentToken, representation, selector };
}

/** @param {BaselineScope} expected @param {{ documentToken: string, representation: string, selector: string | null }} current */
function assertSameScope(expected, current) {
  if (expected.documentToken !== current.documentToken) {
    throw new DomBaselineError(
      ERROR_CODES.DOM_BASELINE_INVALIDATED,
      'DOM baseline belongs to a different document.',
      {
        reason: 'document_token_mismatch',
      }
    );
  }
  if (expected.selector !== current.selector) {
    throw new DomBaselineError(
      ERROR_CODES.DOM_BASELINE_INVALIDATED,
      'DOM baseline selector changed.',
      {
        reason: 'selector_mismatch',
      }
    );
  }
  if (expected.representation !== current.representation) {
    throw new DomBaselineError(
      ERROR_CODES.DOM_BASELINE_INVALIDATED,
      'DOM baseline representation changed.',
      {
        reason: 'representation_mismatch',
      }
    );
  }
}

/** @param {DomBaselineNode[]} nodes */
function normalizeNodes(nodes) {
  /** @type {Map<string, number>} */
  const nextSiblingIndex = new Map();
  return nodes.map((node, sourceIndex) => {
    const parentValue = node.parentId ?? node.parentNodeId ?? null;
    const parentId = parentValue === null ? null : normalizeNodeId(parentValue);
    const parentKey = parentId ?? '__root__';
    const fallbackIndex = nextSiblingIndex.get(parentKey) ?? 0;
    nextSiblingIndex.set(parentKey, fallbackIndex + 1);
    const explicitIndex = node.siblingIndex ?? node.index;
    const tagValue = firstDefined(node.tag, node.tagName);
    const displayName = typeof node.name === 'string' ? node.name : null;
    const textExcerpt = typeof node.textExcerpt === 'string' ? node.textExcerpt : '';
    return {
      id: normalizeNodeId(node.nodeId),
      parentId,
      siblingIndex:
        typeof explicitIndex === 'number' && Number.isFinite(explicitIndex)
          ? explicitIndex
          : fallbackIndex,
      sourceIndex,
      tag: typeof tagValue === 'string' ? tagValue : '',
      role: firstDefined(node.roleFingerprint, node.role),
      name: firstDefined(node.nameFingerprint, node.name),
      text: firstDefined(node.textFingerprint, node.textExcerpt, node.text),
      attrs: firstDefined(node.attrsFingerprint, node.attributesFingerprint, node.attrs),
      state: firstDefined(node.stateFingerprint, node.state),
      displayName,
      textExcerpt,
      attributes: normalizeEvidenceAttributes(node.attrs),
      depth:
        typeof node.depth === 'number' && Number.isFinite(node.depth) ? Math.trunc(node.depth) : 0,
      ancestry: Array.isArray(node.ancestorIds) ? node.ancestorIds.map(String) : [],
      order:
        typeof node.order === 'number' && Number.isFinite(node.order)
          ? Math.trunc(node.order)
          : sourceIndex,
    };
  });
}

/**
 * Mark nodes whose parent changed or whose relative order against another
 * surviving same-parent sibling changed. Added/removed siblings are filtered
 * before the order comparison, so insertion and removal cannot create moves.
 *
 * @param {NormalizedNode[]} beforeNodes
 * @param {NormalizedNode[]} afterNodes
 * @param {Map<string, NormalizedNode>} afterById
 */
function findMovedRoots(beforeNodes, afterNodes, afterById) {
  const candidates = new Set();
  for (const before of beforeNodes) {
    const after = afterById.get(before.id);
    if (after && before.parentId !== after.parentId) candidates.add(before.id);
  }

  const stableParentIds = beforeNodes
    .filter((node) => {
      const after = afterById.get(node.id);
      return after && after.parentId === node.parentId;
    })
    .map((node) => node.id);
  /** @type {Map<string, string[]>} */
  const beforeGroups = groupOrderedIds(beforeNodes, stableParentIds);
  /** @type {Map<string, string[]>} */
  const afterGroups = groupOrderedIds(afterNodes, stableParentIds);
  for (const [parent, beforeIds] of beforeGroups) {
    const afterIds = afterGroups.get(parent) ?? [];
    const oldRank = new Map(beforeIds.map((id, index) => [id, index]));
    const ranks = afterIds.map((id) => oldRank.get(id) ?? -1);
    let prefixMax = -1;
    const movedByPrior = ranks.map((rank) => {
      const moved = rank < prefixMax;
      prefixMax = Math.max(prefixMax, rank);
      return moved;
    });
    let suffixMin = Number.POSITIVE_INFINITY;
    for (let index = ranks.length - 1; index >= 0; index -= 1) {
      if (ranks[index] > suffixMin || movedByPrior[index]) candidates.add(afterIds[index]);
      suffixMin = Math.min(suffixMin, ranks[index]);
    }
  }

  return candidates;
}

/** @param {NormalizedNode[]} nodes @param {string[]} includedIds */
function groupOrderedIds(nodes, includedIds) {
  const included = new Set(includedIds);
  /** @type {Map<string, NormalizedNode[]>} */
  const groups = new Map();
  for (const node of nodes) {
    if (!included.has(node.id)) continue;
    const key = node.parentId ?? '__root__';
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  /** @type {Map<string, string[]>} */
  const result = new Map();
  for (const [key, group] of groups) {
    group.sort(
      (left, right) =>
        left.siblingIndex - right.siblingIndex || left.sourceIndex - right.sourceIndex
    );
    result.set(
      key,
      group.map((node) => node.id)
    );
  }
  return result;
}

/** @param {NormalizedNode} before @param {NormalizedNode} after */
function changedFields(before, after) {
  const fields = ['tag', 'role', 'name', 'text', 'attrs', 'state'];
  return fields.filter(
    (field) => !semanticEqual(Reflect.get(before, field), Reflect.get(after, field))
  );
}

/** @param {NormalizedNode} node @returns {NodeEvidence} */
function toEvidence(node) {
  return {
    tag: typeof node.tag === 'string' ? node.tag : '',
    role: typeof node.role === 'string' ? node.role : null,
    name: node.displayName,
    text: node.textExcerpt,
    attributes: node.attributes,
    depth: node.depth,
  };
}

/** @param {unknown} value @returns {Record<string, string>} */
function normalizeEvidenceAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, string>} */
  const attributes = {};
  for (const [name, entry] of Object.entries(source)) {
    if (typeof entry === 'string') {
      attributes[name] = entry;
      continue;
    }
    if (entry && typeof entry === 'object') {
      const displayed = Reflect.get(entry, 'value');
      if (typeof displayed === 'string') attributes[name] = displayed;
    }
  }
  return attributes;
}

/** @param {NormalizedNode[]} removed @param {NormalizedNode[]} added */
function findAmbiguities(removed, added) {
  /** @type {Map<string, NormalizedNode[]>} */
  const removedBySignature = new Map();
  /** @type {Map<string, NormalizedNode[]>} */
  const addedBySignature = new Map();
  for (const node of removed) addSignature(removedBySignature, node);
  for (const node of added) addSignature(addedBySignature, node);
  let count = 0;
  /** @type {NodeEvidence[]} */
  const examples = [];
  for (const [signature, removedNodes] of removedBySignature) {
    const addedNodes = addedBySignature.get(signature) ?? [];
    const candidateCount = Math.min(removedNodes.length, addedNodes.length);
    count += candidateCount;
    for (let index = 0; index < candidateCount; index += 1) {
      examples.push(toEvidence(addedNodes[index]));
    }
  }
  return { count, examples };
}

/** @param {Map<string, NormalizedNode[]>} target @param {NormalizedNode} node */
function addSignature(target, node) {
  const signature = stableStringify([
    node.tag,
    node.role,
    node.name,
    node.text,
    node.attrs,
    node.state,
    node.ancestry,
  ]);
  const nodes = target.get(signature) ?? [];
  nodes.push(node);
  target.set(signature, nodes);
}

/** @template T @param {T[]} items @param {number} limit @returns {T[]} */
function takeBounded(items, limit) {
  return items.slice(0, Math.max(0, limit));
}

/** @param {number} value */
function normalizeMaxChanges(value) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError('maxChanges must be non-negative.');
  return Math.trunc(value);
}

/** @param {unknown} value */
function normalizeNodeId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) {
    throw new TypeError('Snapshot nodeId must be a non-empty string or number.');
  }
  return String(value);
}

/** @param {unknown[]} values */
function firstDefined(...values) {
  return values.find((value) => value !== undefined) ?? null;
}

/** @param {unknown} left @param {unknown} right */
function semanticEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

/** @param {unknown} value */
function stableStringify(value) {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/** @param {unknown} value @returns {unknown} */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
    return result;
  }
  return value;
}

/** @template T @param {T} value @param {string} name */
function cloneJson(value, name) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON-serializable.`);
  }
  if (json === undefined) throw new TypeError(`${name} must be JSON-serializable.`);
  return {
    clone: /** @type {T} */ (JSON.parse(json)),
    bytes: encoder.encode(json).byteLength,
  };
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(/** @type {Record<string, unknown>} */ (value))) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return /** @type {Readonly<T>} */ (value);
}

/** @param {number} value @param {string} name */
function assertFiniteInteger(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer.`);
}

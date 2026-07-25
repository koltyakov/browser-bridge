// @ts-check

import { DOM_BASELINE_TTL_MS, MAX_DOM_BASELINES_GLOBAL } from '../../protocol/src/index.js';

/**
 * Ownership bookkeeping for retained semantic DOM baselines.
 *
 * A baseline lives in the extension's memory, but the daemon has to know which
 * extension socket owns it so a later `compare`/`describe`/`release` is routed
 * back to the same document, and so the state is dropped when that socket goes
 * away. This module owns only that mapping and its expiry rules; sending the
 * release request over the wire stays with the daemon, which owns transport.
 *
 * @typedef {import('./daemon.js').ClientSocket} ClientSocket
 * @typedef {{ socket: ClientSocket, expiresAt: number }} BaselineOwner
 */

/**
 * Baseline IDs are minted by the extension. The daemon re-validates the shape
 * before trusting one as a map key so a malformed response cannot grow state.
 */
const BASELINE_ID_PATTERN = /^baseline_[A-Za-z0-9_-]{32,64}$/u;

/**
 * Expiry timestamps are allowed a small skew over the nominal TTL to absorb
 * clock jitter between the extension and the daemon.
 */
const EXPIRY_SKEW_MS = 10_000;

/** Cap on tracked mappings per socket, and on abandoned-create entries. */
const MAX_OWNER_MAPPINGS = MAX_DOM_BASELINES_GLOBAL * 4;

/**
 * @param {unknown} baselineId
 * @returns {boolean}
 */
export function isValidBaselineId(baselineId) {
  return typeof baselineId === 'string' && BASELINE_ID_PATTERN.test(baselineId);
}

export class DomBaselineOwnerRegistry {
  /**
   * @param {{ isCurrentExtensionSocket: (socket: ClientSocket) => boolean }} options
   */
  constructor({ isCurrentExtensionSocket }) {
    /** @type {Map<string, BaselineOwner>} */
    this.owners = new Map();
    /**
     * Creates whose agent went away before the extension replied. The response
     * still arrives later, and the baseline it reports has to be released.
     * @type {Map<string, BaselineOwner>}
     */
    this.abandonedCreates = new Map();
    this.isCurrentExtensionSocket = isCurrentExtensionSocket;
  }

  /** @returns {number} */
  get size() {
    return this.owners.size;
  }

  /** Drop every mapping whose TTL has passed. */
  prune() {
    const now = Date.now();
    for (const [baselineId, owner] of this.owners) {
      if (owner.expiresAt <= now) this.owners.delete(baselineId);
    }
  }

  /**
   * Resolve the socket that owns a baseline, or null when the owner is gone,
   * has lost access, or has been replaced by a newer socket for the same
   * extension.
   *
   * @param {string} baselineId
   * @returns {ClientSocket | null}
   */
  get(baselineId) {
    this.prune();
    const owner = this.owners.get(baselineId);
    if (!owner || !owner.socket.__extensionId || !owner.socket.__accessEnabled) return null;
    if (!this.isCurrentExtensionSocket(owner.socket)) {
      this.owners.delete(baselineId);
      return null;
    }
    return owner.socket;
  }

  /**
   * Record ownership for a freshly created baseline.
   *
   * Returns false when the reported ID or expiry is unusable, or when another
   * socket already claims the ID; the caller releases the orphan in that case.
   *
   * @param {string} baselineId
   * @param {ClientSocket} socket
   * @param {unknown} expiresAt
   * @returns {boolean}
   */
  register(baselineId, socket, expiresAt) {
    this.prune();
    const parsedExpiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    const now = Date.now();
    if (
      !isValidBaselineId(baselineId) ||
      !socket.__extensionId ||
      !Number.isFinite(parsedExpiry) ||
      parsedExpiry <= now ||
      parsedExpiry > now + DOM_BASELINE_TTL_MS + EXPIRY_SKEW_MS
    ) {
      return false;
    }
    const existing = this.owners.get(baselineId);
    if (existing && existing.socket !== socket) return false;
    while (
      !existing &&
      [...this.owners.values()].filter((owner) => owner.socket === socket).length >=
        MAX_OWNER_MAPPINGS
    ) {
      const oldest = [...this.owners].find(([, owner]) => owner.socket === socket);
      if (!oldest) break;
      this.owners.delete(oldest[0]);
    }
    this.owners.set(baselineId, { socket, expiresAt: parsedExpiry });
    return true;
  }

  /**
   * @param {string} baselineId
   * @returns {boolean}
   */
  delete(baselineId) {
    return this.owners.delete(baselineId);
  }

  /**
   * Drop a mapping only when the given socket still owns it, so one extension
   * cannot evict another's baseline by reporting its ID.
   *
   * @param {string} baselineId
   * @param {ClientSocket} socket
   * @returns {boolean}
   */
  deleteIfOwnedBy(baselineId, socket) {
    if (this.owners.get(baselineId)?.socket !== socket) return false;
    return this.owners.delete(baselineId);
  }

  /**
   * Forget every baseline and abandoned create belonging to a socket.
   *
   * @param {ClientSocket} socket
   */
  clearForSocket(socket) {
    for (const [baselineId, owner] of this.owners) {
      if (owner.socket === socket) this.owners.delete(baselineId);
    }
    for (const [requestId, abandoned] of this.abandonedCreates) {
      if (abandoned.socket === socket) this.abandonedCreates.delete(requestId);
    }
  }

  /**
   * Remember a `dom.baseline.create` whose agent disconnected before the
   * extension replied, so the eventual response can be released rather than
   * leaking a retained snapshot in the page.
   *
   * @param {string} requestId
   * @param {{ method?: string, targets: Set<ClientSocket> }} pending
   */
  markAbandonedCreate(requestId, pending) {
    if (pending.method !== 'dom.baseline.create') return;
    const target = pending.targets.values().next().value;
    if (!target) return;
    const now = Date.now();
    for (const [id, entry] of this.abandonedCreates) {
      if (entry.expiresAt <= now) this.abandonedCreates.delete(id);
    }
    this.abandonedCreates.set(requestId, {
      socket: target,
      expiresAt: now + DOM_BASELINE_TTL_MS,
    });
    while (this.abandonedCreates.size > MAX_OWNER_MAPPINGS) {
      const oldestId = this.abandonedCreates.keys().next().value;
      if (typeof oldestId !== 'string') break;
      this.abandonedCreates.delete(oldestId);
    }
  }

  /**
   * Claim an abandoned create for the socket that is answering it. Returns
   * false when the request was not abandoned or belongs to another socket.
   *
   * @param {string} requestId
   * @param {ClientSocket} socket
   * @returns {boolean}
   */
  takeAbandonedCreate(requestId, socket) {
    const abandoned = this.abandonedCreates.get(requestId);
    if (abandoned?.socket !== socket) return false;
    this.abandonedCreates.delete(requestId);
    return true;
  }

  /** Drop all tracked state, used on daemon shutdown. */
  clear() {
    this.owners.clear();
    this.abandonedCreates.clear();
  }
}

// @ts-check

const SEMANTIC_INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'grid',
  'link',
  'listbox',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'radiogroup',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'tablist',
  'textbox',
  'treeitem',
  'tree',
  'treegrid',
]);

const ROOT_ROLES = new Set(['rootwebarea', 'webarea', 'document', 'application']);
const DECORATIVE_ROLES = new Set(['none', 'presentation']);

/**
 * @typedef {{
 *   nodeId: string,
 *   role: string,
 *   name: string,
 *   description: string,
 *   value: string,
 *   focused: boolean,
 *   required: boolean,
 *   checked: string | null,
 *   disabled: boolean,
 *   interactive: boolean,
 *   semanticInteractive: boolean,
 *   focusable: boolean,
 *   focusableAndEnabled: boolean,
 *   ignored: boolean,
 *   childIds: string[]
 * }} SimplifiedAXNode
 */

/**
 * Parse a real CDP AXNode. Dynamic states are represented in `properties`, not
 * as top-level fields. The top-level fallback keeps synthetic older fixtures
 * readable without changing real-browser behavior.
 *
 * @param {Record<string, unknown>} node
 * @returns {SimplifiedAXNode}
 */
export function simplifyAXNode(node) {
  const role = axString(node.role);
  const semanticInteractive = isSemanticInteractive(role);
  const focusable = axBoolean(getAXProperty(node, 'focusable'));
  const disabled = axBoolean(getAXProperty(node, 'disabled'));
  const ignored = node.ignored === true;
  return {
    nodeId: String(node.nodeId ?? ''),
    role,
    name: axString(node.name),
    description: axString(node.description),
    value: axString(node.value),
    focused: axBoolean(getAXProperty(node, 'focused')),
    required: axBoolean(getAXProperty(node, 'required')),
    checked: axTristate(getAXProperty(node, 'checked')),
    disabled,
    interactive: semanticInteractive || focusable,
    semanticInteractive,
    focusable,
    focusableAndEnabled: focusable && !disabled && !ignored,
    ignored,
    childIds: Array.isArray(node.childIds) ? node.childIds.map(String) : [],
  };
}

/**
 * Filter before applying maxNodes, then reconnect retained nodes to their
 * nearest retained ancestor. No backend IDs are converted into page refs.
 *
 * @param {Array<Record<string, unknown>>} rawNodes
 * @param {{ compact: boolean, interactiveOnly: boolean, maxNodes: number }} options
 * @returns {{ nodes: SimplifiedAXNode[], filteredCount: number, rawCount: number, rootIds: string[], truncated: boolean, omitted: number, missingChildCount: number }}
 */
export function buildAccessibilityTree(rawNodes, options) {
  const simplified = rawNodes.map(simplifyAXNode).filter((node) => node.nodeId !== '');
  const byId = new Map(simplified.map((node) => [node.nodeId, node]));
  const parentById = new Map();
  let missingChildCount = 0;
  for (const node of simplified) {
    for (const childId of node.childIds) {
      if (!byId.has(childId)) {
        missingChildCount += 1;
      } else if (!parentById.has(childId)) {
        parentById.set(childId, node.nodeId);
      }
    }
  }

  const kept = simplified.filter((node) => {
    if (options.interactiveOnly) return node.semanticInteractive && !node.ignored;
    if (!options.compact) return true;
    return isMeaningfulCompactNode(node);
  });
  const limited = kept.slice(0, options.maxNodes);
  const includedIds = new Set(limited.map((node) => node.nodeId));
  const childrenByParent = new Map();
  /** @type {string[]} */
  const rootIds = [];

  for (const node of limited) {
    let parentId = parentById.get(node.nodeId);
    const visited = new Set();
    while (parentId && !includedIds.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      parentId = parentById.get(parentId);
    }
    if (!parentId || !includedIds.has(parentId)) {
      rootIds.push(node.nodeId);
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(node.nodeId);
    childrenByParent.set(parentId, children);
  }

  const nodes = limited.map((node) => ({
    ...node,
    childIds: childrenByParent.get(node.nodeId) ?? [],
  }));
  return {
    nodes,
    filteredCount: kept.length,
    rawCount: rawNodes.length,
    rootIds,
    truncated: kept.length > limited.length,
    omitted: Math.max(0, kept.length - limited.length),
    missingChildCount,
  };
}

/**
 * Remove unrelated relatives from a partial AX response while retaining the
 * selected subtree and its coherent ancestor chain.
 *
 * @param {Array<Record<string, unknown>>} rawNodes
 * @param {number} backendNodeId
 * @param {number} maxDepth
 * @returns {Array<Record<string, unknown>>}
 */
export function scopeAccessibilityNodes(rawNodes, backendNodeId, maxDepth) {
  const byId = new Map(rawNodes.map((node) => [String(node.nodeId ?? ''), node]));
  const parentById = new Map();
  for (const node of rawNodes) {
    const parentId = String(node.nodeId ?? '');
    for (const childId of Array.isArray(node.childIds) ? node.childIds.map(String) : []) {
      if (!parentById.has(childId)) parentById.set(childId, parentId);
    }
  }
  const target = rawNodes.find((node) => Number(node.backendDOMNodeId) === backendNodeId);
  if (!target) return [];
  const targetId = String(target.nodeId ?? '');
  const included = new Set([targetId]);
  let frontier = [targetId];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const nodeId of frontier) {
      const node = byId.get(nodeId);
      for (const childId of Array.isArray(node?.childIds) ? node.childIds.map(String) : []) {
        if (byId.has(childId) && !included.has(childId)) {
          included.add(childId);
          next.push(childId);
        }
      }
    }
    frontier = next;
  }
  let ancestorId = parentById.get(targetId);
  const visited = new Set();
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    included.add(ancestorId);
    ancestorId = parentById.get(ancestorId);
  }
  return rawNodes.filter((node) => included.has(String(node.nodeId ?? '')));
}

/** @param {SimplifiedAXNode} node */
function isMeaningfulCompactNode(node) {
  if (node.ignored || DECORATIVE_ROLES.has(normalizeRole(node.role))) return false;
  if (node.semanticInteractive || ROOT_ROLES.has(normalizeRole(node.role))) return true;
  return Boolean(node.name || node.description || node.value);
}

/** @param {string} role */
function isSemanticInteractive(role) {
  return SEMANTIC_INTERACTIVE_ROLES.has(normalizeRole(role));
}

/** @param {string} role */
function normalizeRole(role) {
  return role.toLowerCase().replace(/[^a-z]/gu, '');
}

/** @param {Record<string, unknown>} node @param {string} name @returns {unknown} */
function getAXProperty(node, name) {
  if (Array.isArray(node.properties)) {
    const property = node.properties.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        /** @type {{ name?: unknown }} */ (candidate).name === name
    );
    if (property && typeof property === 'object') {
      return /** @type {{ value?: unknown }} */ (property).value;
    }
  }
  return node[name];
}

/** @param {unknown} value @returns {unknown} */
function unwrapAXValue(value) {
  return value && typeof value === 'object' && 'value' in value
    ? /** @type {{ value?: unknown }} */ (value).value
    : value;
}

/** @param {unknown} value */
function axString(value) {
  const unwrapped = unwrapAXValue(value);
  if (typeof unwrapped === 'string') return unwrapped;
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') return String(unwrapped);
  return '';
}

/** @param {unknown} value */
function axBoolean(value) {
  return unwrapAXValue(value) === true;
}

/** @param {unknown} value @returns {string | null} */
function axTristate(value) {
  const unwrapped = unwrapAXValue(value);
  if (unwrapped === true || unwrapped === 'true') return 'true';
  if (unwrapped === false || unwrapped === 'false') return 'false';
  return unwrapped === 'mixed' ? 'mixed' : null;
}

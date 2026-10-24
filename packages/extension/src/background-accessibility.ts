export type SimplifiedAXNode = {
  nodeId: string;
  role: string;
  name: string;
  description: string;
  value: string;
  focused: boolean;
  required: boolean;
  checked: string | null;
  disabled: boolean;
  interactive: boolean;
  semanticInteractive: boolean;
  focusable: boolean;
  focusableAndEnabled: boolean;
  ignored: boolean;
  childIds: string[];
};
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
// Layout text fragments only repeat their StaticText parent's name.
const TEXT_FRAGMENT_ROLES = new Set(['inlinetextbox', 'linebreak']);

/** Parse a real CDP AXNode. Dynamic states are represented in `properties`, not
as top-level fields. The top-level fallback keeps synthetic older fixtures
readable without changing real-browser behavior. */
export function simplifyAXNode(node: Record<string, unknown>): SimplifiedAXNode {
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

/** Filter before applying maxNodes, then reconnect retained nodes to their
nearest retained ancestor. No backend IDs are converted into page refs. */
export function buildAccessibilityTree(
  rawNodes: Array<Record<string, unknown>>,
  options: { compact: boolean; interactiveOnly: boolean; maxNodes: number }
): {
  nodes: SimplifiedAXNode[];
  filteredCount: number;
  rawCount: number;
  rootIds: string[];
  truncated: boolean;
  omitted: number;
  missingChildCount: number;
} {
  const simplified = rawNodes.map(simplifyAXNode).filter((node) => node.nodeId !== '');
  const byId = new Map(simplified.map((node) => [node.nodeId, node]));
  const parentById = new Map<string, string>();
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
    const parentId = parentById.get(node.nodeId);
    return (
      isMeaningfulCompactNode(node) &&
      !repeatsParentText(node, parentId ? byId.get(parentId) : undefined)
    );
  });
  const limited = kept.slice(0, options.maxNodes);
  const includedIds = new Set(limited.map((node) => node.nodeId));
  const childrenByParent = new Map();

  const rootIds: string[] = [];

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

/** Remove unrelated relatives from a partial AX response while retaining the
selected subtree and its coherent ancestor chain. */
export function scopeAccessibilityNodes(
  rawNodes: Array<Record<string, unknown>>,
  backendNodeId: number,
  maxDepth: number
): Array<Record<string, unknown>> {
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

function isMeaningfulCompactNode(node: SimplifiedAXNode) {
  if (node.ignored || DECORATIVE_ROLES.has(normalizeRole(node.role))) return false;
  if (node.semanticInteractive || ROOT_ROLES.has(normalizeRole(node.role))) return true;
  return Boolean(node.name || node.description || node.value);
}

/** Drop text leaves whose content the parent already names, such as the
StaticText under a heading or link with the same accessible name. */
function repeatsParentText(node: SimplifiedAXNode, parent: SimplifiedAXNode | undefined) {
  const role = normalizeRole(node.role);
  if (TEXT_FRAGMENT_ROLES.has(role)) return true;
  return role === 'statictext' && parent !== undefined && parent.name === node.name;
}

function isSemanticInteractive(role: string) {
  return SEMANTIC_INTERACTIVE_ROLES.has(normalizeRole(role));
}

function normalizeRole(role: string) {
  return role.toLowerCase().replace(/[^a-z]/gu, '');
}

function getAXProperty(node: Record<string, unknown>, name: string): unknown {
  if (Array.isArray(node.properties)) {
    const property = node.properties.find(
      (candidate) =>
        candidate &&
        typeof candidate === 'object' &&
        (candidate as { name?: unknown }).name === name
    );
    if (property && typeof property === 'object') {
      return (property as { value?: unknown }).value;
    }
  }
  return node[name];
}

function unwrapAXValue(value: unknown): unknown {
  return value && typeof value === 'object' && 'value' in value
    ? (value as { value?: unknown }).value
    : value;
}

function axString(value: unknown) {
  const unwrapped = unwrapAXValue(value);
  if (typeof unwrapped === 'string') return unwrapped;
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') return String(unwrapped);
  return '';
}

function axBoolean(value: unknown) {
  return unwrapAXValue(value) === true;
}

function axTristate(value: unknown): string | null {
  const unwrapped = unwrapAXValue(value);
  if (unwrapped === true || unwrapped === 'true') return 'true';
  if (unwrapped === false || unwrapped === 'false') return 'false';
  return unwrapped === 'mixed' ? 'mixed' : null;
}

/** Render a filtered AX tree as compact indented `- role "name"` lines. AX
nodes have no page refs; use `source: "dom"` for an actionable outline. */
export function formatAccessibilityOutline(
  nodes: Array<SimplifiedAXNode>,
  rootIds: string[]
): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));

  const lines: string[] = [];
  const visited = new Set();

  const visit = (nodeId: string, depth: number) => {
    const node = byId.get(nodeId);
    if (!node || visited.has(nodeId)) return;
    visited.add(nodeId);

    const states: string[] = [];
    if (node.disabled) states.push('disabled');
    if (node.checked === 'true') states.push('checked');
    else if (node.checked === 'mixed') states.push('mixed');
    if (node.focused) states.push('focused');
    if (node.required) states.push('required');
    if (node.value) states.push(`value=${JSON.stringify(node.value.slice(0, 40))}`);
    const name = node.name ? ` ${JSON.stringify(node.name.slice(0, 80))}` : '';
    lines.push(
      `${'  '.repeat(Math.min(depth, 12))}- ${node.role || 'generic'}${name}${states.length ? ` ${states.join(' ')}` : ''}`
    );
    for (const childId of node.childIds) visit(childId, depth + 1);
  };
  for (const rootId of rootIds) visit(rootId, 0);
  return lines.join('\n');
}

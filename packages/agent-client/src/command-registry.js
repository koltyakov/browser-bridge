// @ts-check

import { BRIDGE_METHOD_REGISTRY, BRIDGE_METHODS } from '../../protocol/src/index.js';
import { parseCommaList, parseIntArg, parsePropertyAssignments } from './cli-helpers.js';

/** @typedef {import('../../protocol/src/types.js').BridgeMethod} BridgeMethod */

/**
 * @typedef {{
 *   method: BridgeMethod,
 *   resolve?: boolean,
 *   printMethod?: string,
 *   usage: string,
 *   description: string,
 *   build: (r: string[], ref?: string) => Record<string, unknown>
 * }} ShortcutCommand
 */

/**
 * @param {BridgeMethod} method
 * @param {string} usage
 * @param {(r: string[], ref?: string) => Record<string, unknown>} build
 * @param {{ resolve?: boolean, printMethod?: string, description?: string }} [options]
 * @returns {ShortcutCommand}
 */
function createShortcutCommand(method, usage, build, options = {}) {
  return {
    method,
    usage,
    description: options.description ?? BRIDGE_METHOD_REGISTRY[method].description.replace(/\.$/, ''),
    build,
    ...(options.resolve ? { resolve: true } : {}),
    ...(options.printMethod ? { printMethod: options.printMethod } : {})
  };
}

/** @type {Record<string, ShortcutCommand>} */
export const SHORTCUT_COMMANDS = {
  'access-request': createShortcutCommand('access.request', 'bbx access-request', () => ({})),
  'dom-query': createShortcutCommand(
    'dom.query',
    'bbx dom-query [selector]',
    (r) => ({ selector: r[0] || 'body' })
  ),
  describe: createShortcutCommand(
    'dom.describe',
    'bbx describe <ref|selector>',
    (_r, ref) => ({ elementRef: ref }),
    { resolve: true, printMethod: 'dom.describe' }
  ),
  text: createShortcutCommand(
    'dom.get_text',
    'bbx text <ref|selector> [budget]',
    (r, ref) => ({ elementRef: ref, textBudget: r[1] ? parseIntArg(r[1], 'budget') : undefined }),
    { resolve: true, printMethod: 'dom.get_text' }
  ),
  styles: createShortcutCommand(
    'styles.get_computed',
    'bbx styles <ref|selector> [props]',
    (r, ref) => ({ elementRef: ref, properties: parseCommaList(r[1]) }),
    { resolve: true, printMethod: 'styles.get_computed' }
  ),
  box: createShortcutCommand(
    'layout.get_box_model',
    'bbx box <ref|selector>',
    (_r, ref) => ({ elementRef: ref }),
    { resolve: true, printMethod: 'layout.get_box_model' }
  ),
  click: createShortcutCommand(
    'input.click',
    'bbx click <ref|selector> [button]',
    (r, ref) => ({ target: { elementRef: ref }, button: r[1] }),
    { resolve: true }
  ),
  focus: createShortcutCommand(
    'input.focus',
    'bbx focus <ref|selector>',
    (_r, ref) => ({ target: { elementRef: ref } }),
    { resolve: true }
  ),
  type: createShortcutCommand(
    'input.type',
    'bbx type <ref|selector> <text...>',
    (r, ref) => ({ target: { elementRef: ref }, text: r.slice(1).join(' ') }),
    { resolve: true }
  ),
  hover: createShortcutCommand(
    'input.hover',
    'bbx hover <ref|selector>',
    (_r, ref) => ({ target: { elementRef: ref } }),
    { resolve: true }
  ),
  html: createShortcutCommand(
    'dom.get_html',
    'bbx html <ref|selector> [maxLen]',
    (r, ref) => ({ elementRef: ref, maxLength: r[1] ? parseIntArg(r[1], 'maxLen') : undefined }),
    { resolve: true }
  ),
  'patch-style': createShortcutCommand(
    'patch.apply_styles',
    'bbx patch-style <ref|sel> prop=val',
    (r, ref) => ({ target: { elementRef: ref }, declarations: parsePropertyAssignments(r.slice(1)) }),
    { resolve: true }
  ),
  'patch-text': createShortcutCommand(
    'patch.apply_dom',
    'bbx patch-text <ref|sel> <text...>',
    (r, ref) => ({ target: { elementRef: ref }, operation: 'set_text', value: r.slice(1).join(' ') }),
    { resolve: true, description: 'Apply a reversible DOM text patch' }
  ),
  patches: createShortcutCommand(
    'patch.list',
    'bbx patches',
    () => ({}),
    { printMethod: 'patch.list' }
  ),
  rollback: createShortcutCommand('patch.rollback', 'bbx rollback <patchId>', (r) => {
    if (!r[0]) throw new Error('Usage: rollback <patchId>');
    return { patchId: r[0] };
  }),
  console: createShortcutCommand(
    'page.get_console',
    'bbx console [level]',
    (r) => ({ level: r[0] || 'all', clear: false }),
    { printMethod: 'page.get_console', description: 'Read buffered console output (log|warn|error|all)' }
  ),
  wait: createShortcutCommand('dom.wait_for', 'bbx wait <selector> [timeoutMs]', (r) => {
    if (!r[0]) throw new Error('Usage: wait <selector> [timeoutMs]');
    return { selector: r[0], timeoutMs: r[1] ? parseIntArg(r[1], 'timeoutMs') : 5000 };
  }),
  find: createShortcutCommand(
    'dom.find_by_text',
    'bbx find <text>',
    (r) => {
      const text = r.join(' ');
      if (!text) throw new Error('Usage: find <text>');
      return { text };
    },
    { printMethod: 'dom.find_by_text' }
  ),
  'find-role': createShortcutCommand('dom.find_by_role', 'bbx find-role <role> [name]', (r) => {
    if (!r[0]) throw new Error('Usage: find-role <role> [name]');
    return { role: r[0], name: r.slice(1).join(' ') || undefined };
  }, { printMethod: 'dom.find_by_role' }),
  navigate: createShortcutCommand('navigation.navigate', 'bbx navigate <url>', (r) => {
    if (!r[0]) throw new Error('Usage: navigate <url>');
    return { url: r[0] };
  }),
  storage: createShortcutCommand(
    'page.get_storage',
    'bbx storage [local|session] [keys]',
    (r) => ({ type: r[0] === 'session' ? 'session' : 'local', keys: r.slice(1).length ? r.slice(1) : undefined })
  ),
  'page-text': createShortcutCommand(
    'page.get_text',
    'bbx page-text [textBudget]',
    (r) => ({ textBudget: r[0] ? parseIntArg(r[0], 'textBudget') : undefined }),
    { printMethod: 'page.get_text' }
  ),
  network: createShortcutCommand(
    'page.get_network',
    'bbx network [limit]',
    (r) => ({ limit: r[0] ? parseIntArg(r[0], 'limit') : undefined }),
    { printMethod: 'page.get_network', description: 'Read buffered network requests (fetch/XHR)' }
  ),
  'a11y-tree': createShortcutCommand(
    'dom.get_accessibility_tree',
    'bbx a11y-tree [maxNodes] [maxDepth]',
    (r) => ({ maxNodes: r[0] ? parseIntArg(r[0], 'maxNodes') : undefined, maxDepth: r[1] ? parseIntArg(r[1], 'maxDepth') : undefined })
  ),
  perf: createShortcutCommand('performance.get_metrics', 'bbx perf', () => ({})),
  scroll: createShortcutCommand('viewport.scroll', 'bbx scroll <top> [left]', (r) => {
    if (!r[0] && !r[1]) throw new Error('Usage: scroll <top> [left]');
    return { top: r[0] ? parseIntArg(r[0], 'top') : undefined, left: r[1] ? parseIntArg(r[1], 'left') : undefined };
  }),
  resize: createShortcutCommand('viewport.resize', 'bbx resize <width> <height>', (r) => {
    if (!r[0] || !r[1]) throw new Error('Usage: resize <width> <height>');
    return { width: parseIntArg(r[0], 'width'), height: parseIntArg(r[1], 'height') };
  }),
  reload: createShortcutCommand('navigation.reload', 'bbx reload', () => ({})),
  back: createShortcutCommand('navigation.go_back', 'bbx back', () => ({})),
  forward: createShortcutCommand('navigation.go_forward', 'bbx forward', () => ({})),
  attrs: createShortcutCommand(
    'dom.get_attributes',
    'bbx attrs <ref|selector> [attr1,...]',
    (r, ref) => ({ elementRef: ref, attributes: parseCommaList(r[1]) }),
    { resolve: true, printMethod: 'dom.get_attributes' }
  ),
  'matched-rules': createShortcutCommand(
    'styles.get_matched_rules',
    'bbx matched-rules <ref|selector>',
    (_r, ref) => ({ elementRef: ref }),
    { resolve: true, printMethod: 'styles.get_matched_rules' }
  )
};

/** @type {Readonly<Record<string, BridgeMethod>>} */
export const CLI_METHOD_BINDINGS = Object.freeze({
  status: 'health.ping',
  logs: 'log.tail',
  tabs: 'tabs.list',
  'tab-create': 'tabs.create',
  'tab-close': 'tabs.close',
  ...Object.fromEntries(
    Object.entries(SHORTCUT_COMMANDS).map(([command, definition]) => [command, definition.method])
  ),
  ...Object.fromEntries(BRIDGE_METHODS.map((method) => [method, method])),
  'press-key': 'input.press_key',
  screenshot: 'screenshot.capture_element',
  eval: 'page.evaluate'
});

/** @type {ReadonlyArray<{ title: string, lines: readonly string[] }>} */
export const CLI_HELP_SECTIONS = Object.freeze([
  {
    title: 'Setup',
    lines: [
      'bbx install [--browser chrome|edge|brave|chromium] [extension-id]  Install native messaging manifest',
      'bbx uninstall                                                      Remove native host manifests, Browser Bridge runtime files, and managed MCP/skill installs',
      'bbx install [--all] [--browser <name>] [extension-id]              Install native host manifest (--all for all supported browsers)',
      'bbx install-skill [targets|all] [--global] [--project <path>]      Install/update the managed Browser Bridge CLI skill',
      'bbx install-mcp [client|all] [--local]                             Write MCP config for codex|claude|cursor|copilot|opencode|antigravity|windsurf',
      'bbx status                                                         Check bridge connection',
      'bbx doctor                                                         Diagnose install, daemon, extension, and access readiness',
      'bbx access-request                                                 Request Browser Bridge access for the focused window',
      'bbx logs                                                           Recent bridge logs',
      'bbx tabs                                                           List available tabs',
      'bbx tab-create [url]                                               Create a new tab',
      'bbx tab-close <tabId>                                              Close a tab',
      'bbx skill                                                          Runtime budget presets and method groups',
      'bbx mcp serve                                                      Start Browser Bridge as an MCP stdio server'
    ]
  },
  {
    title: 'Generic RPC',
    lines: [
      'bbx call [--tab <tabId>] <method> [paramsJson|-]                   Call any bridge method (- reads JSON from stdin)',
      'bbx <method> [--tab <tabId>] [paramsJson|-]                        Direct alias for exact bridge methods such as page.get_state',
      'bbx batch \'[{method,params,tabId?},...]\'                           Parallel method calls',
      'Advanced bridge params stay available through `bbx call`, even when shortcuts expose only the common case.',
      'For open-ended investigation, start with `bbx batch` on `page.get_state`, `dom.query`, and `page.get_text` before any screenshot or CDP call.'
    ]
  },
  {
    title: 'Inspect',
    lines: [
      ...[
        'dom-query',
        'describe',
        'text',
        'html',
        'styles',
        'attrs',
        'matched-rules',
        'box',
        'a11y-tree'
      ].map((command) => `${SHORTCUT_COMMANDS[command].usage.padEnd(64)} ${SHORTCUT_COMMANDS[command].description}`)
    ]
  },
  {
    title: 'Find',
    lines: [
      ...[
        'find',
        'find-role',
        'wait'
      ].map((command) => `${SHORTCUT_COMMANDS[command].usage.padEnd(64)} ${SHORTCUT_COMMANDS[command].description}`)
    ]
  },
  {
    title: 'Page',
    lines: [
      'bbx eval <expression>                                              Evaluate JS in page context (use - for stdin)',
      ...[
        'console',
        'network',
        'page-text',
        'storage',
        'navigate',
        'reload',
        'back',
        'forward',
        'perf',
        'scroll',
        'resize'
      ].map((command) => `${SHORTCUT_COMMANDS[command].usage.padEnd(64)} ${SHORTCUT_COMMANDS[command].description}`)
    ]
  },
  {
    title: 'Interact',
    lines: [
      ...[
        'click',
        'focus',
        'type',
        'hover'
      ].map((command) => `${SHORTCUT_COMMANDS[command].usage.padEnd(64)} ${SHORTCUT_COMMANDS[command].description}`),
      'bbx press-key <key> [ref|selector]                                 Send key event'
    ]
  },
  {
    title: 'Patch',
    lines: [
      ...[
        'patch-style',
        'patch-text',
        'patches',
        'rollback'
      ].map((command) => `${SHORTCUT_COMMANDS[command].usage.padEnd(64)} ${SHORTCUT_COMMANDS[command].description}`)
    ]
  },
  {
    title: 'Capture',
    lines: [
      'bbx screenshot <ref|selector> [path]                               Capture partial element screenshot'
    ]
  }
]);

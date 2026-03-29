// @ts-check

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

/** @type {Record<string, ShortcutCommand>} */
export const SHORTCUT_COMMANDS = {
  'access-request': {
    method: 'access.request',
    usage: 'bbx access-request',
    description: 'Request Browser Bridge access for the focused window',
    build: () => ({})
  },
  'dom-query': {
    method: 'dom.query',
    usage: 'bbx dom-query [selector]',
    description: 'Query DOM subtree',
    build: (r) => ({ selector: r[0] || 'body' })
  },
  describe: {
    method: 'dom.describe',
    resolve: true,
    printMethod: 'dom.describe',
    usage: 'bbx describe <ref|selector>',
    description: 'Describe one element',
    build: (_r, ref) => ({ elementRef: ref })
  },
  text: {
    method: 'dom.get_text',
    resolve: true,
    printMethod: 'dom.get_text',
    usage: 'bbx text <ref|selector> [budget]',
    description: 'Get element text',
    build: (r, ref) => ({ elementRef: ref, textBudget: r[1] ? parseIntArg(r[1], 'budget') : undefined })
  },
  styles: {
    method: 'styles.get_computed',
    resolve: true,
    printMethod: 'styles.get_computed',
    usage: 'bbx styles <ref|selector> [props]',
    description: 'Get computed styles',
    build: (r, ref) => ({ elementRef: ref, properties: parseCommaList(r[1]) })
  },
  box: {
    method: 'layout.get_box_model',
    resolve: true,
    printMethod: 'layout.get_box_model',
    usage: 'bbx box <ref|selector>',
    description: 'Get box model',
    build: (_r, ref) => ({ elementRef: ref })
  },
  click: {
    method: 'input.click',
    resolve: true,
    usage: 'bbx click <ref|selector> [button]',
    description: 'Click element',
    build: (r, ref) => ({ target: { elementRef: ref }, button: r[1] })
  },
  focus: {
    method: 'input.focus',
    resolve: true,
    usage: 'bbx focus <ref|selector>',
    description: 'Focus element',
    build: (_r, ref) => ({ target: { elementRef: ref } })
  },
  type: {
    method: 'input.type',
    resolve: true,
    usage: 'bbx type <ref|selector> <text...>',
    description: 'Type into element',
    build: (r, ref) => ({ target: { elementRef: ref }, text: r.slice(1).join(' ') })
  },
  hover: {
    method: 'input.hover',
    resolve: true,
    usage: 'bbx hover <ref|selector>',
    description: 'Hover over element',
    build: (_r, ref) => ({ target: { elementRef: ref } })
  },
  html: {
    method: 'dom.get_html',
    resolve: true,
    usage: 'bbx html <ref|selector> [maxLen]',
    description: 'Get element HTML',
    build: (r, ref) => ({ elementRef: ref, maxLength: r[1] ? parseIntArg(r[1], 'maxLen') : undefined })
  },
  'patch-style': {
    method: 'patch.apply_styles',
    resolve: true,
    usage: 'bbx patch-style <ref|sel> prop=val',
    description: 'Apply style patch',
    build: (r, ref) => ({ target: { elementRef: ref }, declarations: parsePropertyAssignments(r.slice(1)) })
  },
  'patch-text': {
    method: 'patch.apply_dom',
    resolve: true,
    usage: 'bbx patch-text <ref|sel> <text...>',
    description: 'Apply text patch',
    build: (r, ref) => ({ target: { elementRef: ref }, operation: 'set_text', value: r.slice(1).join(' ') })
  },
  patches: {
    method: 'patch.list',
    printMethod: 'patch.list',
    usage: 'bbx patches',
    description: 'List active patches',
    build: () => ({})
  },
  rollback: {
    method: 'patch.rollback',
    usage: 'bbx rollback <patchId>',
    description: 'Rollback a patch',
    build: (r) => {
      if (!r[0]) throw new Error('Usage: rollback <patchId>');
      return { patchId: r[0] };
    }
  },
  console: {
    method: 'page.get_console',
    printMethod: 'page.get_console',
    usage: 'bbx console [level]',
    description: 'Get console output (log|warn|error|all)',
    build: (r) => ({ level: r[0] || 'all', clear: false })
  },
  wait: {
    method: 'dom.wait_for',
    usage: 'bbx wait <selector> [timeoutMs]',
    description: 'Wait for DOM element',
    build: (r) => {
      if (!r[0]) throw new Error('Usage: wait <selector> [timeoutMs]');
      return { selector: r[0], timeoutMs: r[1] ? parseIntArg(r[1], 'timeoutMs') : 5000 };
    }
  },
  find: {
    method: 'dom.find_by_text',
    printMethod: 'dom.find_by_text',
    usage: 'bbx find <text>',
    description: 'Find elements by text content',
    build: (r) => {
      const text = r.join(' ');
      if (!text) throw new Error('Usage: find <text>');
      return { text };
    }
  },
  'find-role': {
    method: 'dom.find_by_role',
    printMethod: 'dom.find_by_role',
    usage: 'bbx find-role <role> [name]',
    description: 'Find elements by ARIA role',
    build: (r) => {
      if (!r[0]) throw new Error('Usage: find-role <role> [name]');
      return { role: r[0], name: r.slice(1).join(' ') || undefined };
    }
  },
  navigate: {
    method: 'navigation.navigate',
    usage: 'bbx navigate <url>',
    description: 'Navigate to URL',
    build: (r) => {
      if (!r[0]) throw new Error('Usage: navigate <url>');
      return { url: r[0] };
    }
  },
  storage: {
    method: 'page.get_storage',
    usage: 'bbx storage [local|session] [keys]',
    description: 'Read browser storage',
    build: (r) => ({ type: r[0] === 'session' ? 'session' : 'local', keys: r.slice(1).length ? r.slice(1) : undefined })
  },
  'page-text': {
    method: 'page.get_text',
    printMethod: 'page.get_text',
    usage: 'bbx page-text [textBudget]',
    description: 'Get full page text content',
    build: (r) => ({ textBudget: r[0] ? parseIntArg(r[0], 'textBudget') : undefined })
  },
  network: {
    method: 'page.get_network',
    printMethod: 'page.get_network',
    usage: 'bbx network [limit]',
    description: 'Get network requests (fetch/XHR)',
    build: (r) => ({ limit: r[0] ? parseIntArg(r[0], 'limit') : undefined })
  },
  'a11y-tree': {
    method: 'dom.get_accessibility_tree',
    usage: 'bbx a11y-tree [maxNodes] [maxDepth]',
    description: 'Get accessibility tree',
    build: (r) => ({ maxNodes: r[0] ? parseIntArg(r[0], 'maxNodes') : undefined, maxDepth: r[1] ? parseIntArg(r[1], 'maxDepth') : undefined })
  },
  perf: {
    method: 'performance.get_metrics',
    usage: 'bbx perf',
    description: 'Get performance metrics',
    build: () => ({})
  },
  scroll: {
    method: 'viewport.scroll',
    usage: 'bbx scroll <top> [left]',
    description: 'Scroll viewport',
    build: (r) => {
      if (!r[0] && !r[1]) throw new Error('Usage: scroll <top> [left]');
      return { top: r[0] ? parseIntArg(r[0], 'top') : undefined, left: r[1] ? parseIntArg(r[1], 'left') : undefined };
    }
  },
  resize: {
    method: 'viewport.resize',
    usage: 'bbx resize <width> <height>',
    description: 'Resize viewport',
    build: (r) => {
      if (!r[0] || !r[1]) throw new Error('Usage: resize <width> <height>');
      return { width: parseIntArg(r[0], 'width'), height: parseIntArg(r[1], 'height') };
    }
  },
  reload: {
    method: 'navigation.reload',
    usage: 'bbx reload',
    description: 'Reload the current page',
    build: () => ({})
  },
  back: {
    method: 'navigation.go_back',
    usage: 'bbx back',
    description: 'Navigate back',
    build: () => ({})
  },
  forward: {
    method: 'navigation.go_forward',
    usage: 'bbx forward',
    description: 'Navigate forward',
    build: () => ({})
  },
  attrs: {
    method: 'dom.get_attributes',
    resolve: true,
    printMethod: 'dom.get_attributes',
    usage: 'bbx attrs <ref|selector> [attr1,...]',
    description: 'Get element attributes',
    build: (r, ref) => ({ elementRef: ref, attributes: parseCommaList(r[1]) })
  },
  'matched-rules': {
    method: 'styles.get_matched_rules',
    resolve: true,
    printMethod: 'styles.get_matched_rules',
    usage: 'bbx matched-rules <ref|selector>',
    description: 'Get matched CSS rules',
    build: (_r, ref) => ({ elementRef: ref })
  }
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
      'Advanced bridge params stay available through `bbx call`, even when shortcuts expose only the common case.'
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

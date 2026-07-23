// @ts-check

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

/** @typedef {import('../../protocol/src/types.js').ExtractContentResult} ExtractContentResult */
/** @typedef {import('../../protocol/src/types.js').NormalizedExtractContentParams} ExtractContentParams */

const METADATA_LIMITS = Object.freeze({ title: 300, byline: 200, excerpt: 500, siteName: 200 });
const EXCLUDED_SELECTOR =
  'script,style,noscript,template,input,textarea,select,option,button,[hidden],[aria-hidden="true"]';

/** @param {string | null | undefined} value @param {number} limit @returns {string | undefined} */
function boundedText(value, limit) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized.slice(0, limit) : undefined;
}

/** @param {ParentNode} root @returns {void} */
function sanitize(root) {
  for (const element of root.querySelectorAll(EXCLUDED_SELECTOR)) element.remove();
  for (const element of root.querySelectorAll('[style]')) {
    const style = element.getAttribute('style')?.toLowerCase() ?? '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) element.remove();
  }
}

/** @param {Element} element @returns {number} */
function meaningfulLength(element) {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

/** @param {ParentNode} root @returns {Element | null} */
function largestSemanticRoot(root) {
  let best = null;
  let bestLength = 0;
  const candidates = [];
  if (
    'matches' in root &&
    typeof (/** @type {{ matches?: unknown }} */ (root).matches) === 'function' &&
    /** @type {Element} */ (root).matches('article,main,[role="main"]')
  ) {
    candidates.push(/** @type {Element} */ (root));
  }
  candidates.push(...root.querySelectorAll('article,main,[role="main"]'));
  for (const candidate of candidates) {
    const length = meaningfulLength(candidate);
    if (length > bestLength) {
      best = candidate;
      bestLength = length;
    }
  }
  return best;
}

/** @param {Node} node @returns {string} */
function markdownForNode(node) {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ');
  if (node.nodeType !== 1) return '';
  const element = /** @type {Element} */ (node);
  const tag = element.tagName.toLowerCase();
  const children = () => Array.from(element.childNodes, markdownForNode).join('');
  if (/^h[1-6]$/.test(tag)) return `\n${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
  if (['p', 'div', 'section', 'article', 'main'].includes(tag)) {
    return `\n${children().trim()}\n\n`;
  }
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n---\n';
  if (tag === 'strong' || tag === 'b') return `**${children().trim()}**`;
  if (tag === 'em' || tag === 'i') return `*${children().trim()}*`;
  if (tag === 'code' && element.parentElement?.tagName.toLowerCase() !== 'pre') {
    return `\`${(element.textContent ?? '').replace(/`/g, '\\`')}\``;
  }
  if (tag === 'pre') return `\n\`\`\`\n${element.textContent ?? ''}\n\`\`\`\n\n`;
  if (tag === 'blockquote') {
    return `\n${children()
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  }
  if (tag === 'li') {
    const marker =
      element.parentElement?.tagName.toLowerCase() === 'ol'
        ? `${Array.from(element.parentElement.children).indexOf(element) + 1}.`
        : '-';
    return `\n${marker} ${children().trim()}`;
  }
  if (tag === 'ul' || tag === 'ol') return `${children()}\n\n`;
  if (tag === 'a') {
    const label = children().trim();
    const href = element.getAttribute('href')?.trim();
    return href && !/^(?:javascript|data):/i.test(href) ? `[${label}](${href})` : label;
  }
  return children();
}

/** @param {Element} root @param {'text' | 'markdown'} format @returns {string} */
function formatRoot(root, format) {
  if (format === 'markdown') {
    return markdownForNode(root)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return (root.textContent ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** @param {string} content @param {number} budget @param {'text' | 'markdown'} format */
function truncateContent(content, budget, format) {
  if (content.length <= budget) return { content, truncated: false, omitted: 0 };
  const boundary = Math.max(content.lastIndexOf('\n\n', budget), content.lastIndexOf(' ', budget));
  const end = boundary >= Math.floor(budget * 0.7) ? boundary : budget;
  let value = content.slice(0, end).trimEnd();
  if (format === 'markdown' && (value.match(/```/g)?.length ?? 0) % 2 === 1) {
    value = `${value.slice(0, Math.max(0, budget - 4)).trimEnd()}\n\`\`\``;
  }
  return { content: value, truncated: true, omitted: content.length - value.length };
}

/**
 * Convert one bounded browser HTML snapshot into semantic content in Node.
 * Raw HTML is consumed here and never included in the returned result.
 *
 * @param {string} html
 * @param {ExtractContentParams} params
 * @param {{ title?: string, settlement?: ExtractContentResult['settlement'] }} [context]
 * @returns {ExtractContentResult}
 */
export function extractContentFromHtml(html, params, context = {}) {
  const escapedTitle = String(context.title ?? '').replace(/[&<>]/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    return '&gt;';
  });
  const { document } = parseHTML(
    `<!doctype html><html><head><title>${escapedTitle}</title></head><body>${html}</body></html>`
  );
  sanitize(document);
  const semanticRoot = largestSemanticRoot(document.body);
  const semanticLength = semanticRoot ? meaningfulLength(semanticRoot) : 0;
  let readability = null;
  try {
    readability = new Readability(/** @type {Document} */ (document.cloneNode(true))).parse();
  } catch {
    readability = null;
  }

  /** @type {Element} */
  let resultRoot;
  /** @type {import('../../protocol/src/types.js').ExtractContentSource} */
  let source;
  if (readability && (readability.length ?? 0) >= Math.max(200, Math.floor(semanticLength * 0.2))) {
    const template = document.createElement('template');
    template.innerHTML = readability.content ?? '';
    sanitize(template.content);
    const wrapper = document.createElement('article');
    wrapper.append(template.content.cloneNode(true));
    resultRoot = wrapper;
    source = 'readability';
  } else if (semanticRoot && semanticLength > 0) {
    resultRoot = semanticRoot;
    source = 'semantic-root';
  } else {
    resultRoot = document.body;
    source = 'body';
  }

  const formatted = formatRoot(resultRoot, params.format);
  const bounded = truncateContent(formatted, params.textBudget, params.format);
  const metadata = params.includeMetadata
    ? {
        title: boundedText(readability?.title ?? context.title, METADATA_LIMITS.title),
        byline: boundedText(readability?.byline, METADATA_LIMITS.byline),
        excerpt: boundedText(readability?.excerpt, METADATA_LIMITS.excerpt),
        siteName: boundedText(readability?.siteName, METADATA_LIMITS.siteName),
      }
    : {};
  return {
    format: params.format,
    content: bounded.content,
    ...metadata,
    source,
    root: {
      tag: resultRoot.tagName.toLowerCase(),
      ...(params.selector ? { selector: params.selector } : {}),
    },
    length: formatted.length,
    truncated: bounded.truncated,
    omitted: bounded.omitted,
    ...(context.settlement ? { settlement: context.settlement } : {}),
  };
}

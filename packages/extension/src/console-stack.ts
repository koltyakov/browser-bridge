import { sanitizeIncidentalUrl } from '../../../protocol/src/index.js';

export type ConsoleStackFrame = import('../../../protocol/src/types.js').ConsoleStackFrame;

/** Raw stack text kept from the page, before parsing. */
export const MAX_STACK_CHARS = 1_500;
/** Frames kept per entry, top first. */
export const MAX_STACK_FRAMES = 8;
const MAX_STACK_LINES = 64;
const MAX_FUNCTION_CHARS = 200;
const MAX_FRAME_URL_CHARS = 2_048;
const MAX_POSITION = 1_000_000_000;

// C0, DEL, C1, and bidirectional formatting controls. Page and map text ends
// up in a model's context, where these can hide or reorder content.
function isUnsafeCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Strip control and bidi characters and bound the length of untrusted text. */
export function boundUntrustedText(value: string, maxLength: number): string {
  let result = '';
  // Inspect a bounded prefix so a huge input cannot cost a full walk.
  for (const character of value.slice(0, maxLength * 2)) {
    if (result.length >= maxLength) break;
    if (!isUnsafeCodePoint(character.codePointAt(0) ?? 0)) result += character;
  }
  return result.slice(0, maxLength);
}

function parsePosition(value: string): number | null {
  if (!/^\d{1,10}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= MAX_POSITION ? parsed : null;
}

/** Split "url:line:column" from its right, since URLs contain colons. */
function parseLocation(text: string): { url: string; line: number; column: number } | null {
  const match = /^(.*):(\d+):(\d+)$/u.exec(text.trim());
  if (!match || !match[1]) return null;
  const line = parsePosition(match[2]);
  const column = parsePosition(match[3]);
  if (line === null || column === null) return null;
  return { url: match[1], line, column };
}

/** Parse one V8 "    at ..." line. eval and new Function frames report the
call site that created the evaluated code, which is the resolvable position. */
function parseFrameLine(line: string): ConsoleStackFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('at ')) return null;
  let rest = trimmed.slice(3).trim();
  if (rest.startsWith('async ')) rest = rest.slice(6).trim();
  let name = '';
  let locationText = rest;
  const open = rest.indexOf(' (');
  if (rest.endsWith(')') && open > 0) {
    name = rest.slice(0, open).trim();
    locationText = rest.slice(open + 2, -1);
  }
  let location: { url: string; line: number; column: number } | null;
  if (locationText.startsWith('eval at ')) {
    // "eval at outer (https://x/a.js:3:5), <anonymous>:1:7": take the
    // innermost parenthesized position, the outermost real script.
    const callSites = [...locationText.matchAll(/\(([^()]*:\d+:\d+)\)/gu)];
    location = callSites.length ? parseLocation(callSites[callSites.length - 1][1]) : null;
    if (!name) name = 'eval';
  } else {
    location = parseLocation(locationText);
  }
  if (!location) return null;
  const boundedUrl = boundUntrustedText(location.url, MAX_FRAME_URL_CHARS);
  try {
    // V8 reports absolute script URLs; anything else is not a usable frame.
    new URL(boundedUrl);
  } catch {
    return null;
  }
  const url = sanitizeIncidentalUrl(boundedUrl, MAX_FRAME_URL_CHARS);
  if (!url) return null;
  const frame: ConsoleStackFrame = { url, line: location.line, column: location.column };
  const boundedName = boundUntrustedText(name, MAX_FUNCTION_CHARS);
  if (boundedName) frame.function = boundedName;
  return frame;
}

/** Parse V8 stack text into at most eight bounded frames. The page controls
this text completely, so anything that is not a well-formed frame is skipped
and the function never throws. */
export function parseV8Stack(value: unknown): ConsoleStackFrame[] {
  if (typeof value !== 'string' || !value) return [];
  const frames: ConsoleStackFrame[] = [];
  const lines = value.slice(0, MAX_STACK_CHARS).split('\n', MAX_STACK_LINES);
  for (const line of lines) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    const frame = parseFrameLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

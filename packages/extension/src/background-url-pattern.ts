type PatternPart = { literal: string; maxSkip: number };

/** Match Chromium's case-sensitive base::MatchPattern used by Fetch.enable.
 * Wildcard runs permit up to N characters for N question marks, or any length
 * when they contain a star. Backslashes escape the next pattern character.
 * Search literal parts without regex backtracking: O(pattern.length * url.length)
 * time and O(pattern.length) retained memory, even for adversarial patterns. */
export function compileUrlPattern(pattern: string): { test: (url: string) => boolean } {
  const parts: PatternPart[] = [];
  let literal = '';
  let maxSkip = 0;
  const characters = [...pattern];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === '\\') {
      literal += characters[++index] ?? '';
    } else if (character === '*' || character === '?') {
      if (literal) {
        parts.push({ literal, maxSkip });
        literal = '';
        maxSkip = 0;
      }
      if (character === '*') maxSkip = -1;
      else if (maxSkip !== -1) maxSkip += 1;
    } else {
      literal += character;
    }
  }
  parts.push({ literal, maxSkip });

  return {
    test(url) {
      let offset = 0;
      for (const [index, part] of parts.entries()) {
        const last = index === parts.length - 1;
        if (last && !part.literal && part.maxSkip === -1) return true;
        let skipped = 0;
        while (
          !url.startsWith(part.literal, offset) ||
          (last && offset + part.literal.length !== url.length)
        ) {
          if (offset === url.length || skipped === part.maxSkip) return false;
          offset += (url.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
          skipped += 1;
        }
        offset += part.literal.length;
      }
      return true;
    },
  };
}

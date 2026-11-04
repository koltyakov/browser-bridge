type PatternToken = { kind: 'literal'; value: string } | { kind: 'star' } | { kind: 'question' };

/** Match Chromium's case-sensitive base::MatchPattern used by Fetch.enable.
 * Wildcard runs permit up to N characters for N question marks, or any length
 * when they contain a star. Backslashes escape the next pattern character.
 * Track every reachable token without backtracking: O(pattern.length * url.length)
 * time and O(pattern.length) retained memory, even for adversarial patterns. */
export function compileUrlPattern(pattern: string): { test: (url: string) => boolean } {
  const tokens: PatternToken[] = [];
  const characters = [...pattern];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === '\\') {
      const escaped = characters[++index];
      if (escaped !== undefined) tokens.push({ kind: 'literal', value: escaped });
    } else if (character === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (character === '?') {
      tokens.push({ kind: 'question' });
    } else {
      tokens.push({ kind: 'literal', value: character });
    }
  }

  function skipWildcards(states: Uint8Array): void {
    for (let index = 0; index < tokens.length; index += 1) {
      if (states[index] && tokens[index].kind !== 'literal') states[index + 1] = 1;
    }
  }

  return {
    test(url) {
      let active = new Uint8Array(tokens.length + 1);
      let next = new Uint8Array(tokens.length + 1);
      active[0] = 1;
      skipWildcards(active);
      for (const character of url) {
        next.fill(0);
        let matched = false;
        for (let index = 0; index < tokens.length; index += 1) {
          if (!active[index]) continue;
          const token = tokens[index];
          if (token.kind === 'star') next[index] = 1;
          else if (token.kind === 'question' || token.value === character) next[index + 1] = 1;
          else continue;
          matched = true;
        }
        if (!matched) return false;
        skipWildcards(next);
        const previous = active;
        active = next;
        next = previous;
      }
      return active[tokens.length] === 1;
    },
  };
}

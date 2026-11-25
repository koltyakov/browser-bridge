// SOURCES_CONTENT_CANARY_beta: this comment survives only in sourcesContent.
export function parseQuantity(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new RangeError(`beta: not a quantity: ${raw}`);
  }
  return value;
}

(globalThis as Record<string, unknown>).betaParse = parseQuantity;

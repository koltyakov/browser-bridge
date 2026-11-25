// SOURCES_CONTENT_CANARY_alpha: this comment survives only in sourcesContent.
type Order = { id: string; total: number };

export function validateOrder(order: Order): number {
  if (order.total < 0) {
    throw new Error(`alpha: negative total for ${order.id}`);
  }
  return order.total;
}

export function submitOrder(id: string, total: number): number {
  return validateOrder({ id, total });
}

(globalThis as Record<string, unknown>).alphaSubmit = submitOrder;

import type { Counts, Usage } from './types.ts';
import { AdapterValidationError, addCount, count, measurement } from './validation.ts';

function nonnegative(value: number): void {
  count(value, 'metrics');
}

export class Metrics {
  private models: Array<Usage | null> = [];
  private tools = 0;
  private bytes = 0;
  private browser = 0;
  private totals = { input: 0, output: 0, cachedInput: 0, imageInput: 0 };
  constructor(private readonly browserObservable: boolean) {}

  record(value: unknown): void {
    const event = measurement(value);
    if (event.kind === 'model') {
      const totals = { ...this.totals };
      for (const key of ['input', 'output', 'cachedInput', 'imageInput'] as const)
        totals[key] = addCount(totals[key], event.usage?.[key] ?? 0, 'measurement token totals');
      addCount(totals.input, totals.output, 'measurement token totals');
      this.models.push(event.usage);
      this.totals = totals;
    } else if (event.kind === 'tool') {
      const bytes = addCount(this.bytes, event.responseBytes, 'measurement responseBytes total');
      this.tools++;
      this.bytes = bytes;
    } else {
      if (!this.browserObservable)
        throw new AdapterValidationError(
          'measurement',
          'Browser requests are not observable for this driver'
        );
      this.browser++;
    }
  }

  snapshot(): Counts {
    const complete = this.models.length > 0 && this.models.every((usage) => usage !== null);
    return {
      modelRequests: this.models.length,
      hostToolCalls: this.tools,
      browserRequests: this.browserObservable ? this.browser : null,
      responseBytes: this.bytes,
      tokens: complete
        ? {
            input: this.totals.input,
            output: this.totals.output,
            cachedInput: this.models.every((usage) => usage?.cachedInput !== undefined)
              ? this.totals.cachedInput
              : null,
            imageInput: this.models.every((usage) => usage?.imageInput !== undefined)
              ? this.totals.imageInput
              : null,
          }
        : null,
    };
  }
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    fraction > 1 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error('Invalid percentile sample');
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Wilson 95% binomial interval. Never claim zero risk after zero observed events. */
export function successInterval(successes: number, attempts: number): [number, number] | null {
  nonnegative(successes);
  nonnegative(attempts);
  if (successes > attempts) throw new Error('Successes exceed attempts');
  if (!attempts) return null;
  const z = 1.959963984540054;
  const p = successes / attempts;
  const denominator = 1 + (z * z) / attempts;
  const center = (p + (z * z) / (2 * attempts)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / attempts + (z * z) / (4 * attempts * attempts))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

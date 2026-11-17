import { createBrowserBridge } from '../../internal/bridge/generated/code-mode/browser-bridge.mjs';
import { createBrowserBridge as createFromSource } from '../../internal/bridge/generated/code-mode/browser-bridge.js';

// Compiled by make typecheck, not executed. Both shipped declarations and
// generated source must agree, with no blanket parameter or result assertions.
async function typeExamples(): Promise<void> {
  const factory: typeof createBrowserBridge = createFromSource;
  const bridge = factory(async () => ({ structuredContent: { evidence: { count: 1 } } }));
  const result = await bridge.dom.query({ selector: '#app', maxNodes: 5 });
  const count: number = result.structuredContent.evidence.count;
  void count;
  await bridge.health.ping();
  await bridge.dom.baseline.compare({ baselineId: 'baseline' });
  await bridge.input.click({ target: { role: 'button', name: 'Save' }, observe: true });
  await bridge.input.fill({ target: { label: 'Email' }, value: 'a@example.test' });
  // @ts-expect-error fill-only fields are not accepted by click.
  await bridge.input.click({ target: { selector: '#save' }, value: 'unexpected' });
  // @ts-expect-error required parameters cannot be omitted.
  await bridge.input.click();
  // @ts-expect-error input targets must have canonical types.
  await bridge.input.click({ target: 42 });
  // @ts-expect-error misspelled methods are not callable bindings.
  await bridge.dom.get_state();
  // @ts-expect-error no-parameter methods do not accept arbitrary fields.
  await bridge.page.get_state({ execute: 'anything' });
  // @ts-expect-error routing and raw metadata are separate from method parameters.
  await bridge.dom.query({}, { meta: { grant: true } });
  // @ts-expect-error the adapter does not invent per-method return types.
  const unsupported: unknown = result.result.nodes;
  void unsupported;
}
void typeExamples;

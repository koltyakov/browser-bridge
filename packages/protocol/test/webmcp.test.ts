import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRequestParams,
  normalizeWebMcpParams,
  getBridgeOperationTimeoutMs,
  isBatchSafeBridgeCall,
  describeBridgeMethods,
  createFailure,
  createSuccess,
  getMethodCapability,
  applyMethodBudgetPreset,
} from '../src/index.js';
import {
  isRetrySafeBridgeMethod,
  summarizeToolResponse,
} from '../../mcp-server/src/handlers-utils.js';
import { enforceTokenBudget } from '../../extension/src/background-helpers.js';

const toolRef = 'wm_12345678-1234-1234-1234-123456789012';

test('WebMCP registry, capability, batching, and retry policies', () => {
  assert.equal(getMethodCapability('webmcp.list_tools'), 'page.read');
  assert.equal(getMethodCapability('webmcp.execute_tool'), 'automation.input');
  assert.equal(isBatchSafeBridgeCall('webmcp.list_tools'), true);
  assert.equal(isBatchSafeBridgeCall('webmcp.get_tool'), true);
  assert.equal(isBatchSafeBridgeCall('webmcp.execute_tool', { readOnlyHint: true }), false);
  assert.equal(isRetrySafeBridgeMethod('webmcp.execute_tool', {}), false);
  assert.equal(isRetrySafeBridgeMethod('webmcp.get_tool', {}), true);
  const group = describeBridgeMethods({ group: 'webmcp' });
  assert.ok('methods' in group);
  assert.equal(group.methods.length, 3);
  assert.equal(applyMethodBudgetPreset('webmcp.list_tools', {}, 'quick').limit, 5);
  assert.equal(getBridgeOperationTimeoutMs('webmcp.execute_tool', { toolRef }), 80_000);
  assert.equal(getBridgeOperationTimeoutMs('webmcp.list_tools'), 5000);
});

test('WebMCP normalization rejects non-JSON and malformed values without coercion', () => {
  assert.throws(() => normalizeRequestParams('webmcp.get_tool', {}));
  for (const params of [
    { arguments: null },
    { limit: null },
    { toolRef: 'name' },
    { arguments: [] },
    { arguments: { x: undefined } },
    { arguments: { x: Infinity } },
    { arguments: { x: 1n } },
    { arguments: { x: new Date() } },
    { arguments: { x: 'a'.repeat(16384) } },
    { limit: '20' },
    { offset: -1 },
    { query: false },
    { includeDebugging: 'true' },
    { maxBytes: 100000 },
    { timeoutMs: 0 },
    { approvalTimeoutMs: 120000 },
  ])
    assert.throws(() => normalizeWebMcpParams(params));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => normalizeWebMcpParams({ arguments: circular }));
  const original = { nested: { enabled: true } };
  const normalized = normalizeWebMcpParams({ toolRef, arguments: original });
  assert.deepEqual(normalized.arguments, original);
  assert.notEqual(normalized.arguments, original);
});

test('WebMCP schemas and results survive MCP evidence and fail budget checks atomically', () => {
  const payload = {
    tool: {
      toolRef,
      inputSchema: {
        enum: Array.from({ length: 1000 }, (_, i) => `choice-${i}`),
        description: 'x'.repeat(5000),
      },
    },
  };
  const response = createSuccess('schema', payload, { method: 'webmcp.get_tool' });
  const delivered = summarizeToolResponse(response, 'webmcp.get_tool');
  assert.deepEqual(delivered.structuredContent.evidence, payload);
  assert.equal(delivered.structuredContent.outputTruncated, undefined);
  const bounded = enforceTokenBudget('webmcp.get_tool', response, 100);
  assert.equal(bounded.ok, false);
  if (!bounded.ok) assert.equal(bounded.error.code, 'RESULT_TOO_LARGE');
  const executed = enforceTokenBudget(
    'webmcp.execute_tool',
    createSuccess('run', { value: 'x'.repeat(5000) }),
    10
  );
  assert.equal(executed.ok, false);
  if (!executed.ok) {
    assert.equal(executed.error.recovery?.retry, false);
    assert.match(executed.error.recovery?.hint ?? '', /never replay/i);
  }
  const timeout = createFailure('run', 'TIMEOUT', 'expired', null, {
    method: 'webmcp.execute_tool',
  });
  assert.equal(timeout.error.recovery?.retry, false);
});

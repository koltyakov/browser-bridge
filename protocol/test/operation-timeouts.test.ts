import assert from 'node:assert/strict';
import test from 'node:test';
import { getOperationTimeout, OPERATION_TIMEOUT_POLICIES } from '../src/operation-timeouts.js';
import {
  normalizeNavigationAction,
  normalizeWaitForLoadStateParams,
  normalizeEvaluateParams,
  normalizeWaitForParams,
} from '../src/index.js';

test('shared transport policies agree with normalized browser wait bounds', () => {
  for (const timeoutMs of [
    undefined,
    100,
    500,
    15000,
    30000,
    60000,
    120000,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const params = { timeoutMs, selector: '#target' };
    assert.equal(
      getOperationTimeout('navigation.navigate', params),
      normalizeNavigationAction(params).timeoutMs
    );
    assert.equal(
      getOperationTimeout('page.wait_for_load_state', params),
      normalizeWaitForLoadStateParams(params).timeoutMs
    );
    assert.equal(
      getOperationTimeout('page.evaluate', params),
      normalizeEvaluateParams(params).timeoutMs
    );
    assert.equal(
      getOperationTimeout('dom.wait_for', params),
      normalizeWaitForParams(params).timeoutMs
    );
  }
  assert.equal(getOperationTimeout('webmcp.execute_tool', {}), 80000);
  assert.equal(getOperationTimeout('session.export', {}), 100000);
  assert(Object.keys(OPERATION_TIMEOUT_POLICIES).length > 10);
});

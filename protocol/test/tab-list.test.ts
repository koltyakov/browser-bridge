import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSuccess,
  normalizeTabListParams,
  paginateTabList,
  summarizeBridgeResponse,
} from '../src/index.js';

const tabs = Array.from({ length: 47 }, (_, index) => ({
  tabId: index + 1,
  active: false,
  origin: 'https://example.com',
  title: `Tab ${index + 1}`,
}));

test('tab summaries include more than 10 tabs by default', () => {
  const summary = summarizeBridgeResponse(createSuccess('tabs', { tabs }), 'tabs.list');
  assert.match(summary.summary, /showing 30.*17 omitted/);
  assert.ok(Array.isArray(summary.evidence));
  assert.equal(summary.evidence.length, 30);
  assert.deepEqual(summary.pagination, {
    totalCount: 47,
    returnedCount: 30,
    offset: 0,
    omittedCount: 17,
    truncated: true,
    nextOffset: 30,
  });
});

test('tab summaries report the 30-tab preview boundary', () => {
  const manyTabs = Array.from({ length: 147 }, (_, index) => ({ ...tabs[0], tabId: index + 1 }));
  const summary = summarizeBridgeResponse(createSuccess('tabs', { tabs: manyTabs }), 'tabs.list');
  assert.match(summary.summary, /showing 30.*117 omitted/);
  assert.ok(Array.isArray(summary.evidence));
  assert.equal(summary.evidence.length, 30);
  assert.equal(summary.pagination?.nextOffset, 30);
});

test('offset-only tab pages default to 30 while explicit smaller pages are respected', () => {
  const manyTabs = Array.from({ length: 147 }, (_, index) => ({ ...tabs[0], tabId: index + 1 }));
  const page = paginateTabList(manyTabs, { offset: 10 });
  assert.equal(page.tabs.length, 30);
  assert.equal(page.tabs[0].tabId, 11);
  assert.equal(page.pagination.nextOffset, 40);
  assert.equal(paginateTabList(manyTabs, { limit: 5, offset: 10 }).tabs.length, 5);
});

test('requested tab pages are not clipped again by the summarizer', () => {
  const page = paginateTabList(tabs, { limit: 25, offset: 10 });
  const summary = summarizeBridgeResponse(createSuccess('tabs', page), 'tabs.list');
  assert.ok(Array.isArray(summary.evidence));
  assert.equal(summary.evidence.length, 25);
  assert.equal(summary.pagination?.nextOffset, 35);
  assert.equal(page.tabs[0].tabId, 11);
});

test('raw listings stay complete by default and pages report the end correctly', () => {
  assert.equal(paginateTabList(tabs).tabs.length, 47);
  assert.equal(paginateTabList(tabs, { offset: 45 }).tabs.length, 2);
  assert.equal(paginateTabList(tabs, { offset: 45 }).pagination.nextOffset, null);
  assert.equal(paginateTabList(tabs, { offset: 50 }).pagination.nextOffset, null);
  assert.equal(paginateTabList([], { limit: 10 }).pagination.truncated, false);
});

test('tab page parameters reject invalid and unbounded inputs', () => {
  for (const params of [
    { limit: 0 },
    { limit: 101 },
    { limit: '10' },
    { limit: null },
    { offset: null },
    { limit: 1.5 },
    { offset: -1 },
    { offset: NaN },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => normalizeTabListParams(params), { code: 'INVALID_REQUEST' });
  }
});

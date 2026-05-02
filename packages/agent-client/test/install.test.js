// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  SUPPORTED_TARGETS,
  TARGET_LABELS,
  formatManagedSkillSentinel,
  getCoreManagedSkillName,
  getManagedSkillNames,
  getManagedSkillSentinelFilename,
  getManagedPackageVersion,
  getSkillRelativePath,
  isManagedVersionOutdated,
  isSupportedTarget,
  parseInstallAgentArgs,
  parseManagedSkillSentinel,
} from '../src/install.js';
import * as subagent from '../src/subagent.js';
import {
  annotateBridgeSummary as protocolAnnotateBridgeSummary,
  summarizeBridgeResponse as protocolSummarizeBridgeResponse,
} from '../../protocol/src/index.js';

test('install exports the documented supported target surface', () => {
  assert.deepEqual(SUPPORTED_TARGETS, [
    'codex',
    'claude',
    'cursor',
    'copilot',
    'opencode',
    'antigravity',
    'windsurf',
    'agents',
  ]);
  assert.equal(TARGET_LABELS.opencode, 'OpenCode');
  assert.equal(TARGET_LABELS.agents, 'Generic agents');
  assert.equal(getCoreManagedSkillName(), 'browser-bridge');
  assert.deepEqual(getManagedSkillNames(), ['browser-bridge']);
  assert.equal(getManagedSkillSentinelFilename(), '.browser-bridge-managed');
  assert.match(getManagedPackageVersion() || '', /^\d+\.\d+\.\d+/);
});

test('isSupportedTarget rejects aliases and unsupported targets', () => {
  for (const target of SUPPORTED_TARGETS) {
    assert.equal(isSupportedTarget(target), true);
  }

  assert.equal(isSupportedTarget('openai'), false);
  assert.equal(isSupportedTarget('google'), false);
  assert.equal(isSupportedTarget('vscode'), false);
  assert.equal(isSupportedTarget(''), false);
});

test('parseInstallAgentArgs rejects unsupported targets and unknown options', () => {
  assert.throws(
    () => parseInstallAgentArgs(['vscode'], '/tmp/example'),
    /Unknown install-skill target "vscode"/
  );
  assert.throws(
    () => parseInstallAgentArgs(['--agent', ''], '/tmp/example'),
    /Usage: install-skill/
  );
  assert.throws(
    () => parseInstallAgentArgs(['--unknown'], '/tmp/example'),
    /Unknown install-skill option "--unknown"/
  );
  assert.throws(
    () => parseInstallAgentArgs(['copilot', 'cursor'], '/tmp/example'),
    /Unexpected extra argument "cursor"/
  );
});

test('parseInstallAgentArgs deduplicates aliases and honors local/global flags', () => {
  const localOptions = parseInstallAgentArgs(
    ['--agents=openai,codex,google,antigravity', '--project=demo'],
    '/tmp/example'
  );
  assert.deepEqual(localOptions.targets, ['codex', 'antigravity']);
  assert.equal(localOptions.projectPath, '/tmp/example/demo');
  assert.equal(localOptions.global, false);

  const globalOptions = parseInstallAgentArgs(
    ['--agent=all', '--local', '--global'],
    '/tmp/example'
  );
  assert.deepEqual(globalOptions.targets, SUPPORTED_TARGETS);
  assert.equal(globalOptions.global, true);
});

test('getSkillRelativePath uses documented global and local paths', () => {
  assert.equal(getSkillRelativePath('copilot', { global: true }), path.join('.copilot', 'skills'));
  assert.equal(
    getSkillRelativePath('windsurf', { global: true }),
    path.join('.codeium', 'windsurf', 'skills')
  );
  assert.equal(getSkillRelativePath('copilot', { global: false }), path.join('.github', 'skills'));
  assert.equal(
    getSkillRelativePath('antigravity', { global: false }),
    path.join('.agents', 'skills')
  );
  assert.equal(getSkillRelativePath('agents', { global: false }), path.join('.agents', 'skills'));
});

test('managed skill sentinel parsing supports JSON, legacy text, and empty sentinels', () => {
  const sentinel = formatManagedSkillSentinel('browser-bridge');

  assert.match(sentinel, /"skill": "browser-bridge"/);
  assert.deepEqual(parseManagedSkillSentinel(sentinel), {
    managed: true,
    version: getManagedPackageVersion(),
  });
  assert.deepEqual(parseManagedSkillSentinel('legacy-managed\n'), {
    managed: true,
    version: null,
  });
  assert.deepEqual(parseManagedSkillSentinel('   '), {
    managed: true,
    version: null,
  });
});

test('isManagedVersionOutdated handles missing, equal, prerelease, and newer versions', () => {
  assert.equal(isManagedVersionOutdated(null, '1.2.3'), true);
  assert.equal(isManagedVersionOutdated('1.2.3', '1.2.3'), false);
  assert.equal(isManagedVersionOutdated('1.2.4', '1.2.3'), false);
  assert.equal(isManagedVersionOutdated('1.2.3-beta.1', '1.2.3'), true);
  assert.equal(isManagedVersionOutdated('1.2.3', null), false);
});

test('subagent module surface stays limited to protocol summary re-exports', () => {
  assert.deepEqual(Object.keys(subagent).sort(), [
    'annotateBridgeSummary',
    'summarizeBridgeResponse',
  ]);
  assert.equal(subagent.annotateBridgeSummary, protocolAnnotateBridgeSummary);
  assert.equal(subagent.summarizeBridgeResponse, protocolSummarizeBridgeResponse);
});

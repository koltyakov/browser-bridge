import test from 'node:test';
import assert from 'node:assert/strict';

import { registerBridgeMcpGuidance } from '../src/guidance.js';

type PromptRegistration = {
  name: string;
  config: Record<string, unknown>;
  handler: (args?: Record<string, unknown>) => unknown;
};

function getPromptRegistrations(): PromptRegistration[] {
  const registrations: PromptRegistration[] = [];

  registerBridgeMcpGuidance({
    registerPrompt(
      name: string,
      config: Record<string, unknown>,
      handler: (args?: Record<string, unknown>) => unknown
    ) {
      registrations.push({ name, config, handler });
      return {};
    },
  } as Parameters<typeof registerBridgeMcpGuidance>[0]);

  return registrations;
}

function promptText(result: unknown): string {
  const prompt = result as {
    messages: [{ content: { text: string } }];
  };
  return prompt.messages[0].content.text;
}

test('guide prompt returns the general Browser Bridge MCP workflow', () => {
  const guide = getPromptRegistrations().find(
    (registration) => registration.name === 'browser_bridge_guide'
  );

  assert.ok(guide);
  assert.equal(guide.config.title, 'Use Browser Bridge MCP');
  assert.match(promptText(guide.handler()), /browser_status/);
  assert.match(promptText(guide.handler()), /rollback before finishing/);
});

test('investigate prompt normalizes blank arguments to defaults', () => {
  const investigate = getPromptRegistrations().find(
    (registration) => registration.name === 'browser_bridge_investigate'
  );

  assert.ok(investigate);
  const text = promptText(
    investigate.handler({
      objective: '  ',
      selector: '',
    })
  );

  assert.match(text, /Objective: inspect the current page and report findings/);
  assert.match(text, /Scope: normal/);
  assert.match(text, /Initial selector: none; start with main, body, or semantic search/);
});

test('layout debugging prompt includes provided target and symptom', () => {
  const debugLayout = getPromptRegistrations().find(
    (registration) => registration.name === 'browser_bridge_debug_layout'
  );

  assert.ok(debugLayout);
  const text = promptText(
    debugLayout.handler({
      target: '  .card-title ',
      symptom: ' text wraps unexpectedly ',
    })
  );

  assert.match(text, /Target: \.card-title/);
  assert.match(text, /Symptom: text wraps unexpectedly/);
  assert.match(text, /computed styles/);
});

test('flow verification prompt includes provided flow and success criteria', () => {
  const verifyFlow = getPromptRegistrations().find(
    (registration) => registration.name === 'browser_bridge_verify_flow'
  );

  assert.ok(verifyFlow);
  const text = promptText(
    verifyFlow.handler({
      flow: '  sign in and open settings ',
      successCriteria: ' settings page is visible ',
    })
  );

  assert.match(text, /Flow: sign in and open settings/);
  assert.match(text, /Success criteria: settings page is visible/);
  assert.match(text, /browser_input/);
});

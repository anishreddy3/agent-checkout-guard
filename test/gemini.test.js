// Per-model request config: Gemini 3 uses thinking levels and its default
// temperature; Gemini 2.5 uses a thinking budget and the caller's temperature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelConfig } from '../server/gemini.js';

test('Gemini 3 Flash preview: minimal thinking for quick tasks, low for the agent, no temperature', () => {
  assert.deepEqual(modelConfig('gemini-3-flash-preview', { temperature: 0.1 }), { thinkingConfig: { thinkingLevel: 'MINIMAL' } });
  assert.deepEqual(modelConfig('gemini-3-flash-preview', { thinking: 'low' }), { thinkingConfig: { thinkingLevel: 'LOW' } });
});

test('later Gemini 3.x Flash models never get MINIMAL (rejected by the API)', () => {
  assert.equal(modelConfig('gemini-3.8-flash').thinkingConfig.thinkingLevel, 'LOW');
});

test('Gemini 2.5 Flash: thinking budget and the caller temperature', () => {
  assert.deepEqual(modelConfig('gemini-2.5-flash', { temperature: 0.2 }), { thinkingConfig: { thinkingBudget: 0 }, temperature: 0.2 });
  assert.deepEqual(modelConfig('gemini-2.5-flash', { thinking: 'low' }), { thinkingConfig: { thinkingBudget: 1024 } });
});

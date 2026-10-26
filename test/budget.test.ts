import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendBudget, estimateTokens } from '../src/budget.js';
import type { Protocol } from '../src/protocol.js';

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol} budget includes its own overhead without claiming model capacity`, () => {
    const body = protocol === 'responses' ? { input: [] } : protocol === 'gemini' ? { contents: [] } : { messages: [] };
    const result = appendBudget(body, protocol, '<context-folding>guide</context-folding>');
    const text = JSON.stringify(result);
    const used = Number(text.match(/length estimate: (\d+) tokens/)?.[1]);
    assert.equal(used, estimateTokens(result));
    assert.ok(text.includes('<context-folding>guide</context-folding>'));
    assert.ok(!text.includes('Capacity:'));
    assert.ok(!text.includes('ratio'));
    assert.ok(!text.includes('remaining'));
    assert.deepEqual(body, protocol === 'responses' ? { input: [] } : protocol === 'gemini' ? { contents: [] } : { messages: [] });
  });
}

test('protected protocol bodies are unchanged', () => {
  const body = { input: [], previous_response_id: 'prior' };
  assert.deepEqual(appendBudget(body, 'responses'), body);
  const prefill = { messages: [{ role: 'assistant', content: 'prefix' }] };
  assert.deepEqual(appendBudget(prefill, 'anthropic'), prefill);
});

test('budget estimate converges around decimal boundaries including multibyte input', () => {
  for (const length of [0, 100, 3500, 3700, 3900, 3950, 3970, 4000, 39000, 39900]) {
    const result = appendBudget({ messages: [{ role: 'user', content: '文'.repeat(length) }] }, 'chat');
    const used = Number(JSON.stringify(result).match(/length estimate: (\d+) tokens/)?.[1]);
    assert.equal(used, estimateTokens(result));
  }
});

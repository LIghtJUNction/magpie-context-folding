import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendBudget, estimateTokens } from '../src/budget.js';
import type { Protocol } from '../src/protocol.js';

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol} budget includes its own overhead and reports configured capacity`, () => {
    const body = protocol === 'responses' ? { input: [] } : protocol === 'gemini' ? { contents: [] } : { messages: [] };
    const result = appendBudget(body, protocol, 128000, '<context-folding>guide</context-folding>');
    const text = JSON.stringify(result);
    const used = Number(text.match(/length estimate: (\d+) tokens/)?.[1]);
    assert.equal(used, estimateTokens(result));
    assert.ok(text.includes(`used ratio estimate: ${(used / 128000 * 100).toFixed(2)}%`));
    assert.ok(text.includes(`remaining estimate: ${128000 - used} tokens`));
    assert.ok(text.includes('configured'));
    assert.deepEqual(body, protocol === 'responses' ? { input: [] } : protocol === 'gemini' ? { contents: [] } : { messages: [] });
  });
}

test('unknown capacity never fabricates percentages and overflow remains explicit', () => {
  const unknown = JSON.stringify(appendBudget({ messages: [] }, 'chat'));
  assert.ok(unknown.includes('Capacity: unknown; used ratio: unknown; remaining: unknown'));
  assert.ok(!unknown.includes('%'));
  const full = JSON.stringify(appendBudget({ messages: [] }, 'chat', 1));
  assert.ok(full.includes('remaining estimate: 0 tokens'));
  assert.ok(Number(full.match(/ratio estimate: ([\d.]+)%/)?.[1]) > 100);
});

test('protected protocol bodies are unchanged', () => {
  const body = { input: [], previous_response_id: 'prior' };
  assert.deepEqual(appendBudget(body, 'responses', 10000), body);
  const prefill = { messages: [{ role: 'assistant', content: 'prefix' }] };
  assert.deepEqual(appendBudget(prefill, 'anthropic', 10000), prefill);
});

test('budget estimate converges around decimal boundaries including multibyte input', () => {
  for (const length of [0, 100, 3500, 3700, 3900, 3950, 3970, 4000, 39000, 39900]) {
    const result = appendBudget({ messages: [{ role: 'user', content: '文'.repeat(length) }] }, 'chat', 10000);
    const used = Number(JSON.stringify(result).match(/length estimate: (\d+) tokens/)?.[1]);
    assert.equal(used, estimateTokens(result));
  }
});

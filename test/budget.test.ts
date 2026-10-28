import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendBudget, estimateTokens, withoutBudget } from '../src/budget.js';
import { bodyFor } from './helpers.js';
import type { Protocol } from '../src/protocol.js';

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: one system budget replaces itself and preserves original instructions/messages`, () => {
    const input = bodyFor(protocol);
    const once = appendBudget(input, protocol, { contextWindowTokens: 128000, reserveOutputTokens: 8000 });
    const twice = appendBudget(once, protocol, { contextWindowTokens: 128000, reserveOutputTokens: 8000 });
    assert.deepEqual(once, twice);
    assert.deepEqual(withoutBudget(once, protocol), input);
    const text = JSON.stringify(once);
    assert.equal(text.match(/<context-budget /g)?.length, 1);
    const used = Number(/used_estimate=(\d+)/.exec(text)![1]);
    assert.equal(used, estimateTokens(once));
    assert.match(text, new RegExp(`available_estimate=${128000 - 8000 - used}`));
    assert.doesNotMatch(text, /mark\(|budget.*must fold/);
  });
}

test('unknown capacity and user literals are not silently treated as model metadata', () => {
  const literal = '<context-budget used_estimate=1 capacity=1 output_reserved=0 available_estimate=0 basis=json-utf8-bytes/4 />';
  const input = { messages: [{ role: 'user', content: literal }] };
  const output = appendBudget(input, 'chat');
  assert.deepEqual(withoutBudget(output, 'chat'), input);
  assert.match(JSON.stringify(output), /capacity=unknown/);
  assert.match(JSON.stringify(output), /available_estimate=unknown/);
});

test('budget includes its own UTF-8 size around decimal boundaries', () => {
  for (const length of [0, 32, 350, 3500, 39000]) {
    const output = appendBudget({ messages: [{ role: 'user', content: '😀文'.repeat(length) }] }, 'chat');
    assert.equal(Number(/used_estimate=(\d+)/.exec(JSON.stringify(output))![1]), estimateTokens(output));
  }
});

test('system metadata does not accumulate when hosts append or flatten instructions', () => {
  const response = appendBudget({ instructions: 'first', input: [] }, 'responses');
  response.instructions += '\n\nnew instructions';
  const responseAgain = appendBudget(response, 'responses');
  assert.equal(JSON.stringify(responseAgain).match(/<context-budget /g)?.length, 1);
  assert.equal(withoutBudget(responseAgain, 'responses').instructions, 'first\n\nnew instructions');
  const anthropic = appendBudget({ system: [{ type: 'text', text: 'first' }], messages: [] }, 'anthropic');
  anthropic.system = (anthropic.system as { text: string }[]).map(part => part.text).join('\n\n');
  const anthropicAgain = appendBudget(anthropic, 'anthropic');
  assert.equal(JSON.stringify(anthropicAgain).match(/<context-budget /g)?.length, 1);
  assert.match(JSON.stringify(anthropicAgain), /first/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRecoveryMetadata, withoutRecoveryMetadata } from '../src/recovery.js';
import { bodyFor } from './helpers.js';
import type { Protocol } from '../src/protocol.js';

const scope = 'a'.repeat(64);
const nextScope = 'b'.repeat(64);
const metadata = `<context-folding scope=${scope} />`;
const legacyBudget = `<context-budget used_estimate=1 capacity=128000 output_reserved=8000 available_estimate=119999 basis=json-utf8-bytes/4 scope=${scope} />`;

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: recovery scope replaces itself without context budget fields`, () => {
    const input = bodyFor(protocol);
    const before = structuredClone(input);
    const once = appendRecoveryMetadata(input, protocol, scope);
    const twice = appendRecoveryMetadata(once, protocol, scope);
    assert.deepEqual(input, before, 'metadata must not mutate the caller request');
    assert.deepEqual(once, twice);
    assert.deepEqual(withoutRecoveryMetadata(once, protocol), input);
    const text = JSON.stringify(once);
    assert.equal(text.match(/<context-folding scope=/g)?.length, 1);
    assert.ok(text.includes(metadata));
    assert.doesNotMatch(text, /context-budget|used_estimate|capacity=|output_reserved|available_estimate/);
    const updated = appendRecoveryMetadata(once, protocol, nextScope);
    assert.deepEqual(withoutRecoveryMetadata(updated, protocol), input);
    assert.equal(JSON.stringify(updated).match(/<context-folding scope=/g)?.length, 1);
    assert.ok(JSON.stringify(updated).includes(`<context-folding scope=${nextScope} />`));
    assert.ok(!JSON.stringify(updated).includes(metadata));
  });

  test(`${protocol}: upgrading a projected request removes only retired system budget metadata`, () => {
    const input = bodyFor(protocol);
    const once = appendRecoveryMetadata(input, protocol, scope);
    const legacy = JSON.parse(JSON.stringify(once).replace(metadata, legacyBudget)) as Record<string, unknown>;
    assert.deepEqual(withoutRecoveryMetadata(legacy, protocol), input);
    const upgraded = appendRecoveryMetadata(legacy, protocol, scope);
    assert.deepEqual(upgraded, once);
    assert.doesNotMatch(JSON.stringify(upgraded), /context-budget|used_estimate|available_estimate/);
  });

  test(`${protocol}: recovery-looking and old budget-looking user text remains literal`, () => {
    const literal = `${metadata}\n${legacyBudget}`;
    const input: Record<string, unknown> = protocol === 'gemini'
      ? { contents: [{ role: 'user', parts: [{ text: literal }] }] }
      : protocol === 'responses'
        ? { input: [{ role: 'user', content: literal }] }
        : { messages: [{ role: 'user', content: literal }] };
    assert.deepEqual(withoutRecoveryMetadata(input, protocol), input);
    const output = appendRecoveryMetadata(input, protocol, scope);
    assert.deepEqual(withoutRecoveryMetadata(output, protocol), input);
  });
}

test('system metadata does not accumulate when hosts append or flatten instructions', () => {
  const response = appendRecoveryMetadata({ instructions: 'first', input: [] }, 'responses', scope);
  response.instructions += '\n\nnew instructions';
  const responseAgain = appendRecoveryMetadata(response, 'responses', scope);
  assert.equal(JSON.stringify(responseAgain).match(/<context-folding scope=/g)?.length, 1);
  assert.equal(withoutRecoveryMetadata(responseAgain, 'responses').instructions, 'first\n\nnew instructions');
  const anthropic = appendRecoveryMetadata({ system: [{ type: 'text', text: 'first' }], messages: [] }, 'anthropic', scope);
  anthropic.system = (anthropic.system as { text: string }[]).map(part => part.text).join('\n\n');
  const anthropicAgain = appendRecoveryMetadata(anthropic, 'anthropic', scope);
  assert.equal(JSON.stringify(anthropicAgain).match(/<context-folding scope=/g)?.length, 1);
  assert.equal(withoutRecoveryMetadata(anthropicAgain, 'anthropic').system, 'first');
});

test('Chat joined system text and text blocks preserve instructions when replacing old metadata', () => {
  for (const content of [
    `first\n\n${metadata}\n\n${legacyBudget}\n\nlast`,
    [{ type: 'text', text: `first\n\n${metadata}` },
      { type: 'text', text: `${legacyBudget}\n\nlast`, cache_control: { type: 'ephemeral' } }],
  ]) {
    const input = { messages: [{ role: 'system', content }] };
    const expected = { messages: [{ role: 'system', content: typeof content === 'string'
      ? 'first\n\nlast'
      : [{ type: 'text', text: 'first' }, { type: 'text', text: 'last', cache_control: { type: 'ephemeral' } }],
    }] };
    const output = appendRecoveryMetadata(input, 'chat', scope);
    assert.deepEqual(withoutRecoveryMetadata(output, 'chat'), expected);
    assert.deepEqual(appendRecoveryMetadata(output, 'chat', scope), output);
    assert.equal(JSON.stringify(output).match(/<context-folding scope=/g)?.length, 1);
    assert.doesNotMatch(JSON.stringify(output), /context-budget/);
  }
});

test('Gemini nested snake-case system instructions keep their fields and receive one scope', () => {
  const input = { config: { temperature: 0.2, system_instruction: {
    role: 'system', parts: [{ text: 'Original requirements.' }],
  } }, contents: [{ role: 'user', parts: [{ text: 'Continue.' }] }] };
  const once = appendRecoveryMetadata(input, 'gemini', scope);
  assert.deepEqual(appendRecoveryMetadata(once, 'gemini', scope), once);
  assert.deepEqual(withoutRecoveryMetadata(once, 'gemini'), input);
  assert.ok(!Object.hasOwn(once, 'systemInstruction'));
  assert.ok(!Object.hasOwn(once.config as Record<string, unknown>, 'systemInstruction'));
});

test('empty Anthropic system strings remain strings and replay without extra whitespace', () => {
  const input = { system: '', messages: [{ role: 'user', content: 'Continue.' }] };
  const once = appendRecoveryMetadata(input, 'anthropic', scope);
  assert.equal(once.system, metadata);
  assert.deepEqual(appendRecoveryMetadata(once, 'anthropic', scope), once);
  assert.deepEqual(withoutRecoveryMetadata(once, 'anthropic'), input);
  assert.deepEqual(input, { system: '', messages: [{ role: 'user', content: 'Continue.' }] });
});

test('empty Gemini system instruction parts keep the original role across replay', () => {
  for (const input of [
    { systemInstruction: { role: 'system', parts: [] }, contents: [] },
    { config: { temperature: 0.2, system_instruction: { role: 'system', parts: [] } }, contents: [] },
  ]) {
    const before = structuredClone(input);
    const once = appendRecoveryMetadata(input, 'gemini', scope);
    assert.deepEqual(appendRecoveryMetadata(once, 'gemini', scope), once);
    assert.deepEqual(withoutRecoveryMetadata(once, 'gemini'), before);
    assert.deepEqual(input, before);
    assert.equal(JSON.stringify(once).match(/<context-folding scope=/g)?.length, 1);
  }
});

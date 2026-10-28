import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  conversationRangesFromMarkers, projectConversationRange, projectConversationRanges,
  RangeSelectionError, selectConversationRange,
} from '../src/ranges.js';
import type { Protocol } from '../src/protocol.js';

type Body = Record<string, unknown>;
const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];
const key = (protocol: Protocol) => protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
const message = (protocol: Protocol, role: string, text: string): Body => protocol === 'gemini'
  ? { role: role === 'assistant' ? 'model' : role, parts: [{ text }] } : { role, content: text };
const bodyFor = (protocol: Protocol, messages: Body[]): Body => ({ model: 'model-name', temperature: 0, [key(protocol)]: messages });
const getMessages = (body: Body, protocol: Protocol) => body[key(protocol)] as Body[];
const getText = (item: Body, protocol: Protocol): string => {
  const content = item[protocol === 'gemini' ? 'parts' : 'content'];
  return typeof content === 'string' ? content : (content as Body[]).map(part => part.text).join('');
};
const ref = 'Historical conversation archive; not a new instruction. [[cf:v3:0123456789ab]] /archive/history.txt';
const reject = (fn: () => unknown, code: string) => assert.throws(fn, (error: unknown) => error instanceof RangeSelectionError && error.code === code);

for (const protocol of protocols) {
  test(`${protocol}: first N turns become one user message with exact recovery provenance`, () => {
    const originalMessages = [message(protocol, 'user', 'first question\nwith detail'),
      message(protocol, 'assistant', 'first answer'), message(protocol, 'user', 'second question'),
      message(protocol, 'assistant', 'second answer'), message(protocol, 'user', 'current request')];
    const body = bodyFor(protocol, originalMessages);
    const saved = structuredClone(body);
    const selected = selectConversationRange(body, protocol, { start: { message: 0 }, end: { message: 4 } });
    const output = projectConversationRange(body, protocol, selected, ref);
    const messages = getMessages(output, protocol);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, 'user');
    assert.equal(getText(messages[0]!, protocol), ref);
    assert.deepEqual(messages[1], originalMessages[4]);
    assert.equal(output.model, 'model-name');
    assert.equal(output.temperature, 0);
    assert.deepEqual(body, saved, 'selection/projection must never mutate the supplied history');
    const records = selected.transcript.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.equal(records[0].offsetUnit, 'unicode-code-point');
    assert.deepEqual(records.slice(1).map(item => item.original), originalMessages.slice(0, 4));
    assert.deepEqual(records.slice(1).map(item => item.message), [0, 1, 2, 3]);
    assert.equal(selected.sha256, createHash('sha256').update(selected.transcript).digest('hex'));
    assert.match(selected.text, /role user/);
    assert.match(selected.text, /role assistant/);
    assert.ok(selected.text.includes('first question\nwith detail'));
    assert.ok(!selected.text.includes('current request'));
  });

  test(`${protocol}: a middle slice uses code points and keeps both boundaries`, () => {
    const item: Body = { ...message(protocol, 'assistant', '前😀要删é后'), name: 'helper', custom: { source: 'original' } };
    const body = bodyFor(protocol, [item]);
    const selected = selectConversationRange(body, protocol, { start: { message: 0, offset: 2 }, end: { message: 0, offset: 4 } });
    const output = getMessages(projectConversationRange(body, protocol, selected, ref), protocol);
    assert.equal(output.length, 3);
    assert.equal(getText(output[0]!, protocol), '前😀');
    assert.equal(output[0]!.role, item.role);
    assert.equal(getText(output[1]!, protocol), ref);
    assert.equal(output[1]!.role, 'user');
    assert.equal(getText(output[2]!, protocol), 'é后');
    assert.equal(output[2]!.role, item.role);
    assert.deepEqual(output[0]!.custom, item.custom);
    assert.deepEqual(output[2]!.custom, item.custom);
    assert.ok(selected.text.includes('要删'));
    assert.ok(!selected.text.includes('前😀'));
    assert.deepEqual(JSON.parse(selected.transcript.trimEnd().split('\n')[1]!).original, item);
  });

  test(`${protocol}: partial boundaries can span different roles and turns`, () => {
    const body = bodyFor(protocol, [message(protocol, 'user', 'keep-old'), message(protocol, 'assistant', 'middle'), message(protocol, 'user', 'old-keep')]);
    const selected = selectConversationRange(body, protocol, { start: { message: 0, offset: 5 }, end: { message: 2, offset: 4 } });
    const output = getMessages(projectConversationRange(body, protocol, selected, ref), protocol);
    assert.deepEqual(output.map(item => getText(item, protocol)), ['keep-', ref, 'keep']);
    assert.deepEqual(output.map(item => item.role), ['user', 'user', 'user']);
    assert.match(selected.text, /middle/);
    assert.equal(selected.transcript.trimEnd().split('\n').length, 4);
  });

  test(`${protocol}: markers cross user boundaries and ignore tool-looking examples`, () => {
    const body = bodyFor(protocol, [message(protocol, 'assistant', 'outside\n<!-- @context-fold begin all -->\nanalysis'),
      message(protocol, 'user', 'a historical constraint'),
      message(protocol, 'assistant', 'decision\n<!-- @context-fold end all -->\nkeep next task')]);
    const found = conversationRangesFromMarkers(body, protocol);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.label, 'all');
    const selection = selectConversationRange(body, protocol, found[0]!.range);
    const output = getMessages(projectConversationRange(body, protocol, selection, ref), protocol);
    assert.deepEqual(output.map(item => getText(item, protocol)), ['outside\n', ref, 'keep next task']);
    assert.match(selection.text, /a historical constraint/);
    assert.match(selection.text, /@context-fold begin all/);
  });
}

test('message end offset and end-of-history boundary have identical meaning', () => {
  const body = { messages: [{ role: 'user', content: 'a😀b' }] };
  const a = selectConversationRange(body, 'chat', { start: { message: 0 }, end: { message: 0, offset: 3 } });
  const b = selectConversationRange(body, 'chat', { start: { message: 0 }, end: { message: 1 } });
  assert.equal(a.transcript, b.transcript);
  assert.equal(getMessages(projectConversationRange(body, 'chat', a, ref), 'chat').length, 1);
});

test('Responses string input becomes editable user fragments without changing other fields', () => {
  const body = { input: 'prefix MIDDLE suffix', instructions: 'system text', store: false };
  const selected = selectConversationRange(body, 'responses', { start: { message: 0, offset: 7 }, end: { message: 0, offset: 13 } });
  const output = projectConversationRange(body, 'responses', selected, ref);
  assert.deepEqual(getMessages(output, 'responses').map(item => getText(item, 'responses')), ['prefix ', ref, ' suffix']);
  assert.equal(output.instructions, body.instructions);
  assert.equal(output.store, false);
});

test('Responses derived suffix does not reuse the optional message ID', () => {
  const item = { type: 'message', id: 'msg-original', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'abcdef', annotations: [] }] };
  const body = { input: [item] };
  const selected = selectConversationRange(body, 'responses', { start: { message: 0, offset: 2 }, end: { message: 0, offset: 4 } });
  const output = getMessages(projectConversationRange(body, 'responses', selected, ref), 'responses');
  assert.equal(output[0]!.id, 'msg-original');
  assert.equal(output[2]!.id, undefined);
  assert.equal(output[2]!.status, 'completed');
  assert.equal(JSON.parse(selected.transcript.trimEnd().split('\n')[1]!).original.id, 'msg-original');
});

test('multipart text offsets concatenate actual text without inserted separators', () => {
  const body = { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'A😀', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'BC' }, { type: 'text', text: 'DE' }] }] };
  const selected = selectConversationRange(body, 'anthropic', { start: { message: 0, offset: 1 }, end: { message: 0, offset: 5 } });
  const output = getMessages(projectConversationRange(body, 'anthropic', selected, ref), 'anthropic');
  assert.equal(getText(output[0]!, 'anthropic'), 'A');
  assert.equal(getText(output[2]!, 'anthropic'), 'E');
  assert.deepEqual((output[0]!.content as Body[])[0]!.cache_control, { type: 'ephemeral' });
  assert.match(selected.text, /😀\nBC\nD/);
});

function exchange(protocol: Protocol): Body[] {
  if (protocol === 'chat') return [
    { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"source"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'exact tool result' },
  ];
  if (protocol === 'responses') return [
    { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'read("source")' },
    { type: 'custom_tool_call_output', call_id: 'c1', output: 'exact tool result' },
  ];
  if (protocol === 'anthropic') return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'source' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'exact tool result' }] },
  ];
  return [
    { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read', args: { path: 'source' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read', response: { content: 'exact tool result' } } }] },
  ];
}

for (const protocol of protocols) {
  test(`${protocol}: complete tool exchanges can be archived, partial exchanges cannot`, () => {
    const pair = exchange(protocol);
    const body = bodyFor(protocol, [message(protocol, 'user', 'question'), ...pair, message(protocol, 'assistant', 'conclusion')]);
    const selection = selectConversationRange(body, protocol, { start: { message: 1 }, end: { message: 3 } });
    const output = getMessages(projectConversationRange(body, protocol, selection, ref), protocol);
    assert.equal(output.length, 3);
    assert.equal(output[1]!.role, 'user');
    assert.match(selection.text, /exact tool result/);
    assert.deepEqual(selection.transcript.trimEnd().split('\n').slice(1).map(line => JSON.parse(line).original), pair);
    for (const [start, end] of [[1, 2], [2, 3]]) {
      reject(() => selectConversationRange(body, protocol, { start: { message: start! }, end: { message: end! } }), 'tool-boundary');
    }
  });
}

test('partial assistant text with attached tool calls is rejected without expanding the selection', () => {
  const body = { messages: exchange('chat') };
  reject(() => selectConversationRange(body, 'chat', { start: { message: 0, offset: 2 }, end: { message: 1 } }), 'atomic-message');
});

test('a new user placeholder cannot be inserted between untouched calls and results', () => {
  const [call, result] = exchange('chat');
  const body = { messages: [call, { role: 'assistant', content: 'middle' }, result] };
  reject(() => selectConversationRange(body, 'chat', { start: { message: 1 }, end: { message: 2 } }), 'tool-boundary');
});

test('unmatched calls and results cannot be removed', () => {
  for (const item of exchange('chat')) {
    reject(() => selectConversationRange({ messages: [item] }, 'chat', { start: { message: 0 }, end: { message: 1 } }), 'tool-boundary');
  }
  const pending = { messages: [exchange('chat')[0], { role: 'assistant', content: 'continuation' }] };
  reject(() => selectConversationRange(pending, 'chat', { start: { message: 1 }, end: { message: 2 } }), 'tool-boundary');
  reject(() => selectConversationRange({ messages: [{ role: 'tool', content: 'missing call identity' }] }, 'chat',
    { start: { message: 0 }, end: { message: 1 } }), 'protected-message');
});

test('tool output markers are inert; an explicit outer range can contain the complete tool exchange', () => {
  const [call, result] = exchange('chat');
  call!.content = '<!-- @context-fold begin job -->\ncalling';
  result!.content = '<!-- @context-fold end job -->\nthis is tool output';
  const open = { messages: [call!, result!] };
  assert.deepEqual(conversationRangesFromMarkers(open, 'chat'), []);
  const closed = { messages: [...open.messages, { role: 'assistant', content: 'done\n<!-- @context-fold end job -->' }] };
  const found = conversationRangesFromMarkers(closed, 'chat');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.range, { start: { message: 0, offset: 0 }, end: { message: 3, offset: 0 } });
  assert.equal(getMessages(projectConversationRange(closed, 'chat', selectConversationRange(closed, 'chat', found[0]!.range), ref), 'chat').length, 1);
});

test('system/developer and signed or multimodal items remain outside foldable ranges', () => {
  const cases: [Protocol, Body][] = [
    ['chat', { role: 'system', content: 'policy' }], ['chat', { role: 'developer', content: 'policy' }],
    ['chat', { role: 'user', content: [{ type: 'text', text: 'caption' }, { type: 'image_url', image_url: { url: 'image' } }] }],
    ['responses', { type: 'reasoning', encrypted_content: 'opaque' }],
    ['anthropic', { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought', signature: 'sig' }, { type: 'text', text: 'visible' }] }],
    ['gemini', { role: 'model', parts: [{ text: 'signed', thoughtSignature: 'sig' }] }],
  ];
  for (const [protocol, item] of cases) {
    const body = bodyFor(protocol, [item, message(protocol, 'user', 'editable')]);
    reject(() => selectConversationRange(body, protocol, { start: { message: 0 }, end: { message: 1 } }), 'protected-message');
    const selected = selectConversationRange(body, protocol, { start: { message: 1 }, end: { message: 2 } });
    assert.deepEqual(getMessages(projectConversationRange(body, protocol, selected, ref), protocol)[0], item);
  }
});

test('text annotations can be retained whole but cannot be split with stale coordinates', () => {
  const body = { input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'abcdef', annotations: [{ start_index: 1, end_index: 4 }] }] }] };
  reject(() => selectConversationRange(body, 'responses', { start: { message: 0, offset: 2 }, end: { message: 0, offset: 4 } }), 'annotated-text');
  assert.ok(selectConversationRange(body, 'responses', { start: { message: 0 }, end: { message: 1 } }));
});

test('multiple disjoint cuts in one message preserve every intervening character', () => {
  const body = { messages: [{ role: 'assistant', content: 'AAxxBByyCC' }] };
  const first = selectConversationRange(body, 'chat', { start: { message: 0, offset: 2 }, end: { message: 0, offset: 4 } });
  const second = selectConversationRange(body, 'chat', { start: { message: 0, offset: 6 }, end: { message: 0, offset: 8 } });
  const output = getMessages(projectConversationRanges(body, 'chat', [{ selection: second, referenceText: 'second' }, { selection: first, referenceText: 'first' }]), 'chat');
  assert.deepEqual(output.map(item => item.content), ['AA', 'first', 'BB', 'second', 'CC']);
  assert.deepEqual(output.map(item => item.role), ['assistant', 'user', 'assistant', 'user', 'assistant']);
  reject(() => projectConversationRanges(body, 'chat', [{ selection: first, referenceText: ref }, { selection: first, referenceText: ref }]), 'overlapping-ranges');
});

test('content identity survives index shifts and cuts to unselected text, but transcript identity records provenance', () => {
  const original = { input: [{ id: 'original-id', type: 'message', role: 'assistant', content: 'prefixPAYLOADsuffix' }] };
  const a = selectConversationRange(original, 'responses', { start: { message: 0, offset: 6 }, end: { message: 0, offset: 13 } });
  const shifted = { input: [{ role: 'user', content: 'earlier fold' }, { type: 'message', role: 'assistant', content: 'PAYLOADsuffix' }] };
  const b = selectConversationRange(shifted, 'responses', { start: { message: 1 }, end: { message: 1, offset: 7 } });
  assert.equal(a.contentIdentity, b.contentIdentity);
  assert.notEqual(a.sha256, b.sha256);
  const changedRole = { input: [{ role: 'user', content: 'PAYLOAD' }] };
  const c = selectConversationRange(changedRole, 'responses', { start: { message: 0 }, end: { message: 1 } });
  assert.notEqual(a.contentIdentity, c.contentIdentity);
});

test('stale ranges, invalid offsets, hidden history and invalid Unicode never project', () => {
  const body = { messages: [{ role: 'user', content: 'abc' }] };
  const selected = selectConversationRange(body, 'chat', { start: { message: 0 }, end: { message: 1 } });
  reject(() => projectConversationRange({ messages: [{ role: 'user', content: 'changed' }] }, 'chat', selected, ref), 'stale-selection');
  for (const range of [
    { start: { message: -1 }, end: { message: 1 } },
    { start: { message: 0, offset: 0.5 }, end: { message: 1 } },
    { start: { message: 0 }, end: { message: 0, offset: 4 } },
    { start: { message: 0 }, end: { message: 1, offset: 1 } },
    { start: { message: 1 }, end: { message: 2 } },
  ]) reject(() => selectConversationRange(body, 'chat', range), 'invalid-position');
  reject(() => selectConversationRange(body, 'chat', { start: { message: 0 }, end: { message: 0 } }), 'invalid-range');
  reject(() => selectConversationRange({ input: 'abc', previous_response_id: 'previous' }, 'responses', { start: { message: 0 }, end: { message: 1 } }), 'hidden-history');
  reject(() => selectConversationRange({ messages: [{ role: 'user', content: '\uD800' }] }, 'chat', { start: { message: 0 }, end: { message: 1 } }), 'invalid-unicode');
});

test('nested, mismatched, unclosed and already-folded automatic ranges stay literal', () => {
  const valid = '@context-fold begin good\nvalid\n@context-fold end good\n';
  for (const bad of [
    '@context-fold begin outer\n@context-fold begin inner\ntext\n@context-fold end inner\n@context-fold end outer',
    '@context-fold begin outer\ntext\n@context-fold end mismatch\n@context-fold end outer',
    '@context-fold begin outer\ntext',
    '@context-fold begin outer\n[[cf:v3:0123456789ab]]\n@context-fold end outer',
  ]) {
    const body = { messages: [{ role: 'assistant', content: valid + bad }] };
    const found = conversationRangesFromMarkers(body, 'chat');
    assert.equal(found.length, 1);
    assert.equal(found[0]!.label, 'good');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { activityProtectedSpans, isPluginGuide, toolActivity } from '../src/activity.js';
import { extractSpans, type Protocol, type Span } from '../src/protocol.js';

const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];
const names = ['context_folding', 'mcp__magpie__magpie_context_folding_context_folding', 'mcp__plugin__context_folding', 'plugin.context_folding'];

function exchange(protocol: Protocol, name: string, output = 'tool output', flags: Record<string, unknown> = {}, args: unknown = {}): Record<string, unknown> {
  if (protocol === 'chat') return { messages: [
    { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: 'call-1', content: output, ...flags },
    { role: 'user', content: 'Continue the task' },
  ] };
  if (protocol === 'responses') return { input: [
    { type: 'function_call', call_id: 'call-1', name, arguments: JSON.stringify(args) },
    { type: 'function_call_output', call_id: 'call-1', output, ...flags },
    { role: 'user', content: 'Continue the task' },
  ] };
  if (protocol === 'anthropic') return { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name, input: args }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: output, ...flags }] },
    { role: 'user', content: 'Continue the task' },
  ] };
  return { contents: [
    { role: 'model', parts: [{ functionCall: { id: 'call-1', name, args } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'call-1', name, response: { output, ...flags } } }] },
    { role: 'user', parts: [{ text: 'Continue the task' }] },
  ] };
}

function toolSpan(body: Record<string, unknown>, protocol: Protocol): Span {
  const span = extractSpans(body, protocol).find(span => span.role === 'tool');
  assert.ok(span);
  return span;
}

test('plugin control and recovery results retain their identities across protocols and namespaces', () => {
  for (const protocol of protocols) for (const name of names) {
    const body = exchange(protocol, name, JSON.stringify({ scope: 'scope', entries: ['large recovered text'] }));
    const original = structuredClone(body);
    const span = toolSpan(body, protocol);
    assert.equal(span.toolName, name, protocol);
    assert.equal(span.activityReason, 'plugin-control', protocol);
    assert.equal(span.protectedReason, undefined, 'semantic protection must not disable unrelated folding');
    assert.equal(activityProtectedSpans(extractSpans(body, protocol), 2).get(span.id), 'plugin-control');
    assert.deepEqual(body, original);
    assert.equal(toolSpan(exchange(protocol, 'read', span.text), protocol).id, span.id, 'metadata cannot change archive identity');
  }
});

test('failed result envelopes preserve identity even when file provenance is rejected', () => {
  for (const protocol of protocols) for (const flags of [{ is_error: true }, { isError: true }, { status: 'failed' }, { exit_code: 1 }, { success: false }]) {
    const span = toolSpan(exchange(protocol, 'read', 'AssertionError: expected 200, received 500', flags, { path: 'a' }), protocol);
    assert.equal(span.toolName, 'read');
    assert.equal(span.activityReason, 'tool-error', `${protocol}/${JSON.stringify(flags)}`);
    assert.equal(span.source, undefined, 'failure details must not replace the last successful file version');
    assert.equal(activityProtectedSpans([span], 2).get(span.id), 'tool-error', 'a new user turn does not resolve an error');
  }
});

test('actionable authorization, failed tests and commit receipts survive later user turns', () => {
  const cases = [
    ['browser_auth', JSON.stringify({ status: 'authorization_pending', verification_uri: 'https://example.test/authorize', user_code: 'ABCD' }), 'authorization-required'],
    ['browser_auth', JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ authorization_url: 'https://example.test/authorize' }) }] }), 'authorization-required'],
    ['exec_command', JSON.stringify({ output: 'test details', exit_code: 1 }), 'tool-error'],
    ['exec_command', 'FAIL test/account.test.ts\nExpected 200, received 500', 'tool-error'],
    ['exec_command', '(fail) protects the active browser auth result\n1 tests failed:', 'tool-error'],
    ['exec_command', 'test result: FAILED. 3 passed; 1 failed', 'tool-error'],
    ['exec_command', '[main a123456] Fix active context\n 3 files changed', 'operation-receipt'],
    ['mcp__codex_apps__github_create_commit', JSON.stringify({ sha: 'a'.repeat(40), url: 'https://example.test/commit' }), 'operation-receipt'],
  ] as const;
  for (const protocol of protocols) for (const [name, output, reason] of cases) {
    const span = toolSpan(exchange(protocol, name, output), protocol);
    assert.equal(span.activityReason, reason, `${protocol}/${name}`);
    assert.equal(activityProtectedSpans([span], 2).get(span.id), reason);
  }
});

test('code-mode control calls are recognized without treating quoted examples as calls', () => {
  for (const code of [
    'text(await tools.context_folding({action: "status"}));',
    'const result = await tools["context_folding"]({action: "read"}); text(result);',
    'await Promise.all([tools.context_folding({action: "list"}), tools.read({path: "a"})]);',
    'text(await tools.mcp__magpie__magpie_context_folding_context_folding({action: "mark"}));',
  ]) {
    for (const protocol of protocols) {
      assert.equal(toolSpan(exchange(protocol, 'functions.exec', 'control output', {}, { code }), protocol).activityReason, 'plugin-control');
    }
    const body = { input: [
      { type: 'custom_tool_call', call_id: 'code', name: 'exec', input: code },
      { type: 'custom_tool_call_output', call_id: 'code', output: 'control output' },
    ] };
    assert.equal(toolSpan(body, 'responses').activityReason, 'plugin-control');
  }
  for (const code of [
    'text("tools.context_folding({action: \\\"status\\\"})");',
    '// tools.context_folding({action: "read"});\ntext(await tools.read({path: "a"}));',
    '/* tools.context_folding({}); */ text("result");',
    'const pattern = /tools.context_folding({})/; text(pattern);',
    'text(`tools.context_folding({})`);',
    'text(await tools.context_folding_help({}));',
  ]) assert.equal(toolActivity('exec', code, 'ordinary output'), undefined, code);
  assert.equal(toolActivity('read', { code: 'tools.context_folding({})' }, 'ordinary output'), undefined);
});

test('ordinary mentions and successful statuses do not create durable protection', () => {
  for (const output of [
    'This document describes errors, authorization and git commits.',
    JSON.stringify({ status: 'completed', authorization_url: 'https://example.test/old', error: null, exit_code: 0 }),
    JSON.stringify({ schema: { status: 'authorization_required', error: 'example' } }),
    'Tests: 0 failed, 42 passed',
  ]) assert.equal(toolActivity('read', {}, output), undefined, output);
});

test('structural control provenance protects dynamic aliases and nested responses, including errors', () => {
  const code = 'const name = getToolName(); const fold = tools[name]; text(await fold({action: "read"}));';
  assert.equal(toolActivity('exec', code, 'ordinary output'), undefined, 'dynamic tool identity is not guessed');
  const payload = JSON.stringify({ _contextFolding: 'control-result', error: 'Invalid context_folding arguments', details: [] });
  for (const protocol of protocols) {
    const direct = toolSpan(exchange(protocol, 'exec', payload, {}, { code }), protocol);
    assert.equal(direct.activityReason, 'plugin-control');
    const nested = JSON.stringify({ isError: true, content: [{ type: 'text', text: payload }] });
    assert.equal(toolSpan(exchange(protocol, 'exec', nested, {}, { code }), protocol).activityReason, 'plugin-control');
    const structured = JSON.stringify({ results: [{ structuredContent: { _contextFolding: 'control-result', entries: ['restored original'] } }] });
    assert.equal(toolSpan(exchange(protocol, 'unknown_wrapper', structured), protocol).activityReason, 'plugin-control');
  }
  for (const value of ['control-result-example', true, null]) {
    assert.equal(toolActivity('read', {}, JSON.stringify({ _contextFolding: value })), undefined, 'marker must match exactly');
  }
  assert.equal(toolActivity('read', {}, JSON.stringify({ schema: { _contextFolding: 'control-result' } })), undefined, 'schema descriptions are not result envelopes');
});

test('all current-turn tools stay visible, while ordinary consumed history remains eligible', () => {
  const body = { messages: [
    { role: 'user', content: 'Old task' },
    { role: 'tool', content: 'old output' },
    { role: 'assistant', content: 'Finished' },
    { role: 'user', content: 'Current task' },
    { role: 'tool', content: 'current output A' },
    { role: 'assistant', content: 'Working' },
    { role: 'tool', content: 'current output B' },
  ] };
  const spans = extractSpans(body, 'chat');
  const protection = activityProtectedSpans(spans, 3);
  assert.deepEqual([...protection.keys()], spans.filter(span => span.role === 'tool' && span.messageIndex >= 3).map(span => span.id));
  const noUser = spans.filter(span => span.role !== 'user');
  assert.deepEqual([...activityProtectedSpans(noUser, -1).keys()], [noUser.at(-1)!.id]);
  assert.equal(activityProtectedSpans([...noUser, { ...noUser[1]!, id: 'consumed', messageIndex: 7 }], -1).size, 0);
});

test('repeated result envelopes and ID-less Gemini controls cannot turn into ordinary history', () => {
  const body = exchange('responses', 'context_folding');
  const input = body.input as Record<string, unknown>[];
  input.splice(2, 0, { ...input[1], output: 'second control output' });
  assert.ok(extractSpans(body, 'responses').filter(span => span.role === 'tool').every(span => span.activityReason === 'plugin-control'));
  const gemini = { contents: [
    { role: 'model', parts: [{ functionCall: { name: 'context_folding', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'context_folding', response: { output: 'status result' } } }] },
  ] };
  assert.equal(toolSpan(gemini, 'gemini').activityReason, 'plugin-control');
});

test('synthetic guide-only text does not masquerade as a new user turn or consume a result', () => {
  const guide = `<context-folding scope=${'a'.repeat(64)}>\ntools["context_folding"]\n</context-folding>`;
  const budget = '<context-budget>Estimate: 12 tokens</context-budget>';
  const receipt = '<context-folding-receipts>\n{"state":"applied"}\n</context-folding-receipts>';
  for (const text of [guide, budget, receipt, `${budget}\n\n${guide}\n${receipt}`]) assert.equal(isPluginGuide(text), true, text);
  for (const text of ['', `${guide}\nContinue`, `My question\n${guide}`, `<example>${guide}</example>`, '<context-folding>not closed']) {
    assert.equal(isPluginGuide(text), false, text);
  }
  const spans = extractSpans({ messages: [
    { role: 'tool', content: 'new tool result' },
    { role: 'user', content: `${guide}\n${receipt}` },
  ] }, 'chat');
  assert.equal(activityProtectedSpans(spans, -1).get(spans[0]!.id), 'active-tool-result');
  assert.equal(activityProtectedSpans(spans, -1).get(spans[1]!.id), 'plugin-control', 'a receipt must not become foldable user history');
});

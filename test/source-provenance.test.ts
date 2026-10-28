import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { withoutBudget } from '../src/budget.js';
import { digest } from '../src/store.js';
import { reference } from '../src/annotations.js';
import { bodyFor, fixture, progress } from './helpers.js';

const code = '  execute_operation("中文😀");\n'.repeat(70).trimEnd();
const source = `// @context-fold begin work\n${code}\n// @context-fold end work\n`;
function readBody(protocol: Protocol, text = source, id = 'read-1', name = 'read'): Record<string, unknown> {
  const base = bodyFor(protocol);
  if (protocol === 'chat') return { ...base, messages: [
    { role: 'user', content: 'Inspect source.' },
    { role: 'assistant', content: 'Reading.', tool_calls: [{ id, type: 'function', function: { name, arguments: '{"path":"worker.ts"}' } }] },
    { role: 'tool', tool_call_id: id, content: text }, { role: 'user', content: 'Continue.' },
  ] };
  if (protocol === 'responses') return { ...base, input: [
    { type: 'function_call', call_id: id, name, arguments: '{"path":"worker.ts"}' },
    { type: 'function_call_output', call_id: id, output: text }, { role: 'user', content: 'Continue.' },
  ] };
  if (protocol === 'anthropic') return { ...base, messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { path: 'worker.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, { role: 'user', content: 'Continue.' },
  ] };
  return { ...base, contents: [
    { role: 'model', parts: [{ functionCall: { id, name, args: { path: 'worker.ts' } } }] },
    { role: 'user', parts: [{ functionResponse: { id, name, response: { output: text } } }] },
    { role: 'user', parts: [{ text: 'Continue.' }] },
  ] };
}
const toolText = (body: Record<string, unknown>, protocol: Protocol) => extractSpans(body, protocol).find(span => span.role === 'tool')!.text;

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: a verified source read folds only comments, fresh occurrences get a grace period, and old hashes recover`, async () => {
    await fixture(async ({ context, scope, store }) => {
      const input = readBody(protocol);
      const first = await onRequest(input, context) as Record<string, unknown>;
      assert.equal(toolText(first, protocol), source);
      const compact = await onRequest(progress(input, protocol), context) as Record<string, unknown>;
      const expected = source.replace(code, reference(digest(code).slice(0, 12), store.paths(scope, { text: code }).path));
      assert.equal(toolText(compact, protocol), expected);
      const fresh = readBody(protocol, source, 'read-2');
      assert.equal(toolText(await onRequest(fresh, context) as Record<string, unknown>, protocol), source);
      const updated = readBody(protocol, source.replace('execute_operation', 'changed_operation'), 'read-3');
      assert.equal(toolText(await onRequest(updated, context) as Record<string, unknown>, protocol), toolText(updated, protocol));
      const updatedCompact = await onRequest(progress(updated, protocol), context) as Record<string, unknown>;
      assert.notEqual(toolText(updatedCompact, protocol), expected);
      const old = JSON.parse(await execute({ action: 'read', scope, id: digest(code).slice(0, 12), limit: 24000 }));
      assert.equal(old.text, code);
      assert.equal(old.sha256, digest(code));
      const normal = readBody(protocol, source, 'exec-1', 'exec');
      const normalOutput = await onRequest(normal, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.deepEqual(withoutBudget(normalOutput, protocol), normal, 'generic tool output cannot become source by containing markers');
      const recovery = readBody(protocol, source, 'recovery-1', 'context_folding');
      assert.deepEqual(withoutBudget(await onRequest(recovery, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>, protocol), recovery);
    }, protocol);
  });
}

test('unmarked source, read failures and missing provenance are never auto-selected', async () => {
  await fixture(async ({ context }) => {
    for (const body of [readBody('chat', code), { ...readBody('chat'), messages: [
      { role: 'tool', content: source }, { role: 'user', content: 'Continue.' },
    ] }, { ...readBody('chat'), messages: [
      { role: 'assistant', tool_calls: [{ id: 'error', type: 'function', function: { name: 'read', arguments: '{"path":"worker.ts"}' } }] },
      { role: 'tool', tool_call_id: 'error', content: source, is_error: true }, { role: 'user', content: 'Continue.' },
    ] }]) {
      const output = await onRequest(body, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.deepEqual(withoutBudget(output, 'chat'), body);
    }
  });
});

test('quoted Python/TypeScript source markers are data; actual surrounding comments still work', async () => {
  await fixture(async ({ context }) => {
    const literals = [
      ['example.py', `example = """\n# @context-fold begin sample\n${code}\n# @context-fold end sample\n"""\n`],
      ['example.ts', 'const example = `\n// @context-fold begin sample\n' + code + '\n// @context-fold end sample\n`;\n'],
    ];
    for (const [path, text] of literals) {
      const input = readBody('chat', text!);
      const messages = input.messages as Record<string, unknown>[];
      (messages[1]!.tool_calls as { function: { arguments: string } }[])[0]!.function.arguments = JSON.stringify({ path });
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      assert.equal(toolText(output, 'chat'), text);
    }
  });
});

test('duplicate reads mature identically when history contains an earlier projection', async () => {
  await fixture(async ({ context }) => {
    const first = readBody('chat');
    await onRequest(first, context);
    const twice = structuredClone(first);
    const messages = twice.messages as Record<string, unknown>[];
    messages.splice(3, 0,
      { role: 'assistant', tool_calls: [{ id: 'read-2', type: 'function', function: { name: 'read', arguments: '{"path":"worker.ts"}' } }] },
      { role: 'tool', tool_call_id: 'read-2', content: source });
    const compact = await onRequest(twice, context) as Record<string, unknown>;
    const firstTools = extractSpans(compact, 'chat').filter(span => span.role === 'tool');
    assert.match(firstTools[0]!.text, /\[\[cf:v3:/);
    assert.equal(firstTools[1]!.text, source);
    const third = await onRequest(progress(compact, 'chat'), context) as Record<string, unknown>;
    const nextTools = extractSpans(third, 'chat').filter(span => span.role === 'tool');
    assert.ok(nextTools.every(span => span.text.includes('[[cf:v3:')));
  });
});

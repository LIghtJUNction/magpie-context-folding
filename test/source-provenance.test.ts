import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { execute } from '../src/tool.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { withoutRecoveryMetadata } from '../src/recovery.js';
import { withoutGuidance } from '../src/guidance.js';
import { digest } from '../src/store.js';
import { bodyFor, fixture, progress } from './helpers.js';
const withoutMetadata = (body: Record<string, unknown>, protocol: Protocol) => withoutGuidance(withoutRecoveryMetadata(body, protocol), protocol);


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
function appendRead(body: Record<string, unknown>, protocol: Protocol, text: string, id: string, name = 'read', args: Record<string, unknown> = { path: 'worker.ts' }): void {
  const messages = protocol === 'responses' ? body.input as Record<string, unknown>[]
    : protocol === 'gemini' ? body.contents as Record<string, unknown>[] : body.messages as Record<string, unknown>[];
  const insertion = messages.length - 1;
  if (protocol === 'chat') {
    messages.splice(insertion, 0,
      { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      { role: 'tool', tool_call_id: id, content: text });
  } else if (protocol === 'responses') {
    messages.splice(insertion, 0,
      { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) },
      { type: 'function_call_output', call_id: id, output: text });
  } else if (protocol === 'anthropic') {
    messages.splice(insertion, 0,
      { role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] });
  } else {
    messages.splice(insertion, 0,
      { role: 'model', parts: [{ functionCall: { id, name, args } }] },
      { role: 'user', parts: [{ functionResponse: { id, name, response: { output: text } } }] });
  }
}
function appendAnswer(body: Record<string, unknown>, protocol: Protocol): void {
  const messages = protocol === 'responses' ? body.input as Record<string, unknown>[]
    : protocol === 'gemini' ? body.contents as Record<string, unknown>[] : body.messages as Record<string, unknown>[];
  const answer = protocol === 'chat' ? { role: 'assistant', content: 'The first answer is complete.' }
    : protocol === 'responses' ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The first answer is complete.' }] }
      : protocol === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: 'The first answer is complete.' }] }
        : { role: 'model', parts: [{ text: 'The first answer is complete.' }] };
  messages.splice(messages.length - 1, 0, answer);
}
function setFollowup(body: Record<string, unknown>, protocol: Protocol, text: string): void {
  const messages = protocol === 'responses' ? body.input as Record<string, unknown>[]
    : protocol === 'gemini' ? body.contents as Record<string, unknown>[] : body.messages as Record<string, unknown>[];
  const last = messages[messages.length - 1]!;
  if (protocol === 'gemini') last.parts = [{ text }];
  else last.content = text;
}
const toolText = (body: Record<string, unknown>, protocol: Protocol) => extractSpans(body, protocol).find(span => span.role === 'tool')!.text;

const completeSource = 'export function lookup() { return 8341; }\n'.repeat(90);
for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: a completed full source read folds only after a later user turn`, async () => {
    await fixture(async ({ context, scope }) => {
      const fastContext = { ...context, options: { delayRequests: 0 } };
      const input = readBody(protocol, completeSource);
      const first = await onRequest(input, fastContext) as Record<string, unknown>;
      assert.equal(toolText(first, protocol), completeSource, 'the first exposure stays complete');
      const unfinished = await onRequest(input, fastContext) as Record<string, unknown>;
      assert.equal(toolText(unfinished, protocol), completeSource, 'a later request without an answer stays complete');

      const followedUp = structuredClone(input);
      appendAnswer(followedUp, protocol);
      const compact = await onRequest(followedUp, fastContext) as Record<string, unknown>;
      const reference = `[[cf:v2:${digest(completeSource).slice(0, 12)}]]`;
      assert.equal(toolText(compact, protocol), reference);
      const restored = JSON.parse(await execute({ action: 'read', scope,
        id: digest(completeSource).slice(0, 12), limit: 24000 }));
      assert.equal(restored.text, completeSource, 'the archived source remains exactly recoverable');
    }, protocol);
  });

  test(`${protocol}: a source-related follow-up keeps the full read available`, async () => {
    await fixture(async ({ context }) => {
      const fastContext = { ...context, options: { delayRequests: 0 } };
      for (const question of ['From worker.ts, what does operation341() return?', 'What was the result?']) {
        const input = readBody(protocol, completeSource);
        appendAnswer(input, protocol);
        setFollowup(input, protocol, question);
        const first = await onRequest(input, fastContext) as Record<string, unknown>;
        const current = await onRequest(input, fastContext) as Record<string, unknown>;
        assert.equal(toolText(first, protocol), completeSource);
        assert.equal(toolText(current, protocol), completeSource);
      }
    }, protocol);
  });
}

test('an assistant tool call after a source read does not count as a completed answer', async () => {
  await fixture(async ({ context }) => {
    const fastContext = { ...context, options: { delayRequests: 0 } };
    const input = readBody('chat', completeSource);
    const messages = input.messages as Record<string, unknown>[];
    messages.splice(messages.length - 1, 1,
      { role: 'assistant', content: 'Still checking.', tool_calls: [{ id: 'check-1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"inspect"}' } }] },
      { role: 'tool', tool_call_id: 'check-1', content: 'checked' },
      { role: 'user', content: 'Continue.' });
    const first = await onRequest(input, fastContext) as Record<string, unknown>;
    const current = await onRequest(input, fastContext) as Record<string, unknown>;
    assert.equal(toolText(first, 'chat'), completeSource);
    assert.equal(toolText(current, 'chat'), completeSource);
  });
});

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: a verified source read folds only comments, fresh occurrences get a grace period, and old hashes recover`, async () => {
    await fixture(async ({ context, scope }) => {
      const input = readBody(protocol);
      const first = await onRequest(input, context) as Record<string, unknown>;
      assert.equal(toolText(first, protocol), source);
      const compact = await onRequest(progress(input, protocol), context) as Record<string, unknown>;
      const expected = source.replace(code, `[[cf:v2:${digest(code).slice(0, 12)}]]`);
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
      assert.deepEqual(withoutMetadata(normalOutput, protocol), normal, 'generic tool output cannot become source by containing markers');
      const recovery = readBody(protocol, source, 'recovery-1', 'context_folding');
      assert.deepEqual(withoutMetadata(await onRequest(recovery, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>, protocol), recovery);
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
      assert.deepEqual(withoutMetadata(output, 'chat'), body);
    }
  });
});

const repeatedFile = Array.from({ length: 360 }, (_, index) => `export function operation${index}() { return ${index}; }\n`).join('');

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: only later identical full reads are folded automatically`, async () => {
    await fixture(async ({ context, scope }) => {
      const input = readBody(protocol, repeatedFile, 'read-1', 'read');
      appendRead(input, protocol, repeatedFile, 'read-2');
      const originalTools = extractSpans(input, protocol).filter(span => span.role === 'tool');
      assert.deepEqual(originalTools.map(span => span.source?.range), ['full', 'full']);

      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      const tools = extractSpans(output, protocol).filter(span => span.role === 'tool');
      assert.equal(tools[0]!.text, repeatedFile, 'the first complete source copy remains available');
      assert.equal(tools[1]!.text, `[[cf:v2:${digest(repeatedFile).slice(0, 12)}]]`);
      assert.equal(extractSpans(input, protocol).filter(span => span.role === 'tool')[1]!.text, repeatedFile,
        'projection does not mutate the caller input');

      const recovered = JSON.parse(await execute({ action: 'read', scope, id: digest(repeatedFile).slice(0, 12), limit: 24000 }));
      assert.equal(recovered.text, repeatedFile);
      assert.equal(recovered.sha256, digest(repeatedFile));
    }, protocol);
  });
}

test('a resolvable source reference can anchor a later identical full read after the old copy is gone', async () => {
  await fixture(async ({ context }) => {
    const first = readBody('chat', repeatedFile, 'read-1', 'read');
    appendRead(first, 'chat', repeatedFile, 'read-2');
    const compact = await onRequest(first, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const reference = extractSpans(compact, 'chat').filter(span => span.role === 'tool')[1]!.text;
    assert.match(reference, /^\[\[cf:v2:/);

    const replay = readBody('chat', reference, 'read-2', 'read');
    appendRead(replay, 'chat', repeatedFile, 'read-3');
    const waiting = await onRequest(replay, context) as Record<string, unknown>;
    assert.equal(extractSpans(waiting, 'chat').filter(span => span.role === 'tool')[1]!.text, repeatedFile,
      'the configured grace request retains a new full read');
    const output = await onRequest(progress(waiting, 'chat'), context) as Record<string, unknown>;
    const tools = extractSpans(output, 'chat').filter(span => span.role === 'tool');
    assert.equal(tools[0]!.text, reference, 'the prior projection remains intact');
    assert.equal(tools[1]!.text, reference, 'the identical source is linked to its verified archived copy');
    assert.ok(Buffer.byteLength(JSON.stringify(replay)) - Buffer.byteLength(JSON.stringify(output)) > repeatedFile.length / 2,
      'the full serialized request shrinks after including the recovery guidance overhead');

    const differentPath = readBody('chat', reference, 'read-2', 'read');
    appendRead(differentPath, 'chat', repeatedFile, 'read-4', 'read', { path: 'other.ts' });
    const differentPathOutput = await onRequest(differentPath, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.equal(extractSpans(differentPathOutput, 'chat').filter(span => span.role === 'tool')[1]!.text, repeatedFile,
      'a prior reference for another path does not authorize folding');

    const changedContent = `${repeatedFile}\n// changed`;
    const changed = readBody('chat', reference, 'read-2', 'read');
    appendRead(changed, 'chat', changedContent, 'read-5');
    const changedOutput = await onRequest(changed, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.equal(extractSpans(changedOutput, 'chat').filter(span => span.role === 'tool')[1]!.text, changedContent,
      'a stale reference does not authorize folding changed file contents');

    const unknown = readBody('chat', `[[cf:v2:${'a'.repeat(64)}]]`, 'unknown-1', 'read');
    appendRead(unknown, 'chat', repeatedFile, 'unknown-2');
    const unknownOutput = await onRequest(unknown, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.equal(extractSpans(unknownOutput, 'chat').filter(span => span.role === 'tool')[1]!.text, repeatedFile,
      'an unresolvable reference cannot authorize automatic folding');
  });
});

test('automatic duplicate folding ignores partial, changed, differently pathed, and generic tool results', async () => {
  await fixture(async ({ context }) => {
    const partial = repeatedFile.slice(0, 180);
    const cases = [
      { text: repeatedFile, args: { path: 'other.ts' }, name: 'read' },
      { text: `${repeatedFile}\n// changed`, args: { path: 'worker.ts' }, name: 'read' },
      { text: partial, args: { path: 'worker.ts', offset: 0, limit: partial.length }, name: 'read' },
      { text: repeatedFile, args: { path: 'worker.ts' }, name: 'exec' },
    ];
    for (const item of cases) {
      const input = readBody('chat', repeatedFile, 'read-1', 'read');
      appendRead(input, 'chat', item.text, 'read-2', item.name, item.args);
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
      const tools = extractSpans(output, 'chat').filter(span => span.role === 'tool');
      assert.equal(tools[0]!.text, repeatedFile);
      assert.equal(tools[1]!.text, item.text);
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
    assert.match(firstTools[0]!.text, /\[\[cf:v2:/);
    assert.equal(firstTools[1]!.text, source);
    const third = await onRequest(progress(compact, 'chat'), context) as Record<string, unknown>;
    const nextTools = extractSpans(third, 'chat').filter(span => span.role === 'tool');
    assert.ok(nextTools.every(span => span.text.includes('[[cf:v2:')));
  });
});

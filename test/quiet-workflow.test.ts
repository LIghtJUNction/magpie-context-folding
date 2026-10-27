import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';

type Body = Record<string, any>;
const options = { thresholdTokens: 1, keepRecentMessages: 0, headChars: 0,
  policy: { mode: 'bytes', autoRoles: ['tool'], minChars: 1, summaryChars: 256 } };
const protocols: Protocol[] = ['chat', 'responses', 'anthropic', 'gemini'];
const key = (protocol: Protocol) => protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
const user = (protocol: Protocol, text: string) => protocol === 'gemini'
  ? { role: 'user', parts: [{ text }] } : { role: 'user', content: text };
function exchange(protocol: Protocol, id: string, name: string, output: string, args: Body = {}): Body[] {
  if (protocol === 'chat') return [
    { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: output },
  ];
  if (protocol === 'responses') return [
    { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) },
    { type: 'function_call_output', call_id: id, output },
  ];
  if (protocol === 'anthropic') return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name, input: args }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] },
  ];
  return [
    { role: 'model', parts: [{ functionCall: { id, name, args } }] },
    { role: 'user', parts: [{ functionResponse: { id, name, response: { output } } }] },
  ];
}
function request(protocol: Protocol, messages: Body[]): Body {
  const tool = { name: 'context_folding', parameters: { type: 'object' } };
  const tools = protocol === 'chat' ? [{ type: 'function', function: tool }]
    : protocol === 'responses' ? [{ type: 'function', ...tool }]
    : protocol === 'anthropic' ? [{ name: tool.name, input_schema: tool.parameters }]
    : [{ functionDeclarations: [tool] }];
  return { tools, [key(protocol)]: messages };
}
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'folding-quiet-workflow-'));
  const previous = { state: process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR, config: process.env.XDG_CONFIG_HOME };
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  process.env.XDG_CONFIG_HOME = join(directory, 'config');
  try { await run(directory); }
  finally {
    if (previous.state === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous.state;
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.config;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const protocol of protocols) {
  test(`${protocol}: current auth, failures, commit receipts and plugin readback survive aggressive folding`, async () => {
    await fixture(async directory => {
      const ordinary = 'Completed old catalog listing; no pending action.\n'.repeat(1400);
      const auth = JSON.stringify({ status: 'authorization_required', authorization_url: 'https://example.test/authorize',
        instructions: 'Use this active authorization card.\n'.repeat(300) });
      const failure = JSON.stringify({ exit_code: 1, output: 'FAIL account.test.ts\nExpected balance=100, actual=99.\n'.repeat(250) });
      const commit = '[main 123abcd] Verified commit\n' + 'src/main.ts updated\n'.repeat(400);
      const control = JSON.stringify({ entries: Array.from({ length: 200 }, (_, i) => ({ id: `entry-${i}`, folded: false })) });
      const body = request(protocol, [
        ...exchange(protocol, 'old', 'list_catalog', ordinary),
        ...exchange(protocol, 'auth', 'browser_authorization', auth),
        ...exchange(protocol, 'failure', 'exec_command', failure),
        ...exchange(protocol, 'commit', 'exec_command', commit),
        ...exchange(protocol, 'control', 'context_folding', control, { action: 'list' }),
        ...exchange(protocol, 'wrapped', 'functions.exec', control, { code: 'text(await tools.context_folding({action:"status"}));' }),
        user(protocol, 'Continue collecting evidence; do not edit source.'),
      ]);
      const ctx = { protocol, model: 'synthetic', session: `quiet-${protocol}`, options };
      const before = structuredClone(body);
      const result = await onRequest(body, ctx) as Body;
      const originalTools = extractSpans(body, protocol).filter(span => span.role === 'tool');
      const resultTools = extractSpans(result, protocol).filter(span => span.role === 'tool');
      assert.match(resultTools[0]!.text, /^\[context-folding id=/, 'ordinary completed history remains foldable');
      assert.deepEqual(resultTools.slice(1).map(span => span.text), originalTools.slice(1).map(span => span.text));
      const serialized = JSON.stringify(result);
      for (const unwanted of ['context-budget', 'source-fold-markers', 'skills directory', 'Batch mark', 'Folding mode:']) {
        assert.ok(!serialized.includes(unwanted), unwanted);
      }
      assert.ok(serialized.includes('read(scope,id)'));
      assert.deepEqual(body, before);
      const scope = await new Store(directory).scopeFor(JSON.stringify([ctx.session, '', '', '']));
      for (const index of [1, 4, 5]) {
        const marked = JSON.parse(await execute({ action: 'mark', scope,
          marks: [{ id: originalTools[index]!.id, disposition: 'foldable', summary: 'Still needed.' }] }));
        assert.equal(marked.state, 'skipped');
        assert.equal(marked.pending, false);
        assert.equal(marked.counts.folded, 0);
        assert.equal(marked.targets[0].reason, index === 1 ? 'authorization-required' : 'plugin-control');
      }
      const next = await onRequest(body, ctx) as Body;
      assert.deepEqual(extractSpans(next, protocol).filter(span => span.role === 'tool').slice(1).map(span => span.text),
        originalTools.slice(1).map(span => span.text));
    });
  });

  test(`${protocol}: all tools in the active user turn stay expanded even with recent protection set to zero`, async () => {
    await fixture(async directory => {
      const messages: Body[] = [user(protocol, 'Use these results for the next step.')];
      for (let index = 0; index < 18; index++) messages.push(...exchange(protocol, `call-${index}`, `inspect_${index}`,
        `active result ${index}\n`.repeat(500)));
      const body = request(protocol, messages);
      const ctx = { protocol, model: 'synthetic', session: `active-${protocol}`, options };
      const output = await onRequest(body, ctx) as Body;
      const toolsBefore = extractSpans(body, protocol).filter(span => span.role === 'tool');
      assert.deepEqual(extractSpans(output, protocol).filter(span => span.role === 'tool').map(span => span.text), toolsBefore.map(span => span.text));
      assert.ok(!JSON.stringify(output).includes('[context-folding id='));
      assert.ok(!JSON.stringify(output).includes('read(scope,id)'));
      const scope = await new Store(directory).scopeFor(JSON.stringify([ctx.session, '', '', '']));
      const mark = JSON.parse(await execute({ action: 'mark', scope,
        marks: [{ id: toolsBefore[0]!.id, disposition: 'foldable', summary: 'Cannot hide this active result.' }] }));
      assert.equal(mark.targets[0].reason, 'active-tool-result');
      assert.equal(mark.state, 'skipped');
    });
  });
}

test('no real user plus a saved plugin guide cannot make the latest error manually foldable', async () => {
  await fixture(async directory => {
    const guide = `<context-folding scope=${'a'.repeat(64)}>\ntools["context_folding"]\n</context-folding>`;
    const body = request('chat', [...exchange('chat', 'failure', 'exec_command', JSON.stringify({ exit_code: 1, output: 'Error details\n'.repeat(1000) })),
      user('chat', guide)]);
    const ctx = { protocol: 'chat', model: 'synthetic', session: 'no-user', options };
    await onRequest(body, ctx);
    const scope = await new Store(directory).scopeFor(JSON.stringify([ctx.session, '', '', '']));
    const span = extractSpans(body, 'chat').find(span => span.role === 'tool')!;
    const mark = JSON.parse(await execute({ action: 'mark', scope, marks: [{ id: span.id, disposition: 'foldable', summary: 'Still active.' }] }));
    assert.equal(mark.state, 'skipped');
    assert.equal(mark.targets[0].reason, 'active-tool-result');
  });
});

test('actual plugin statistics remain readable through an opaque code-mode alias', async () => {
  await fixture(async () => {
    const control = await execute({ action: 'stats' });
    assert.equal(JSON.parse(control)._contextFolding, 'control-result');
    for (const protocol of protocols) {
      const body = request(protocol, [
        ...exchange(protocol, 'opaque', 'functions.exec', control,
          { code: 'const readback = tools[toolName]; text(await readback(request));' }),
        user(protocol, 'Use the returned statistics to assess whether the plugin helped.'),
      ]);
      const output = await onRequest(body, { protocol, model: 'synthetic', session: `opaque-${protocol}`, options }) as Body;
      assert.equal(extractSpans(output, protocol).find(span => span.role === 'tool')!.text, control);
    }
  });
});

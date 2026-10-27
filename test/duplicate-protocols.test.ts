import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol, type Span } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';

const evidence = 'Exact observation: 原文🙂 "quotes", \\paths, and trailing spaces.  \n'.repeat(100);
const recentAnswer = 'Recent explanation remains complete. 原文🙂\n'.repeat(30);
const requirements = 'Keep the current requirements and complete recent evidence.';
const args = { query: '原文🙂 "quoted"', nested: { values: [1, false, null] } };
const rawArgs = JSON.stringify(args, null, 2);
type Body = Record<string, any>;
type Variant = { protocol: Protocol; custom?: boolean };
const variants: Variant[] = [
  { protocol: 'chat' }, { protocol: 'responses' }, { protocol: 'responses', custom: true },
  { protocol: 'anthropic' }, { protocol: 'gemini' },
];
const keyFor = (protocol: Protocol) => protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';

function request({ protocol, custom }: Variant): Body {
  const exchange = (id: string) => {
    if (protocol === 'chat') return [
      { role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'inspect', arguments: rawArgs } }] },
      { role: 'tool', tool_call_id: id, content: evidence },
    ];
    if (protocol === 'responses') return [
      custom ? { type: 'custom_tool_call', id: `item-${id}`, call_id: id, name: 'inspect', input: 'const result = await inspect(' + rawArgs + '); text(result);' }
        : { type: 'function_call', id: `item-${id}`, call_id: id, name: 'inspect', arguments: rawArgs },
      { type: custom ? 'custom_tool_call_output' : 'function_call_output', id: `output-${id}`, call_id: id, output: evidence },
    ];
    if (protocol === 'anthropic') return [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'opaque thought', signature: `signed-${id}` },
        { type: 'tool_use', id, name: 'inspect', input: structuredClone(args) }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: [{ type: 'text', text: evidence }] }] },
    ];
    return [
      { role: 'model', parts: [{ text: 'opaque thought', thought: true, thoughtSignature: `signed-${id}` },
        { functionCall: { id, name: 'inspect', args: structuredClone(args) } }] },
      { role: 'user', parts: [{ functionResponse: { id, name: 'inspect', response: { output: evidence, count: 17 } } }] },
    ];
  };
  const text = (role: 'assistant' | 'user', value: string) => protocol === 'gemini'
    ? { role: role === 'assistant' ? 'model' : role, parts: [{ text: value }] }
    : { role, content: [{ type: protocol === 'responses' ? role === 'user' ? 'input_text' : 'output_text' : 'text', text: value }] };
  const tool = { name: 'context_folding', parameters: { type: 'object' } };
  const tools = protocol === 'chat' ? [{ type: 'function', function: tool }]
    : protocol === 'responses' ? [{ type: 'function', ...tool }]
    : protocol === 'anthropic' ? [{ name: tool.name, input_schema: tool.parameters }]
    : [{ functionDeclarations: [tool] }];
  return {
    model: 'synthetic', stream: false,
    tools,
    [keyFor(protocol)]: [...exchange('old-id'), text('assistant', 'Earlier observation finished.'),
      ...exchange('anchor-id'), text('assistant', recentAnswer), text('user', requirements)],
  };
}

function toolSpans(body: Body, protocol: Protocol): Span[] {
  return extractSpans(body, protocol).filter(span => span.role === 'tool');
}

function setText(body: Body, path: Span['path'], text: string): void {
  let parent = body;
  for (const key of path.slice(0, -1)) parent = parent[key];
  parent[path.at(-1)!] = text;
}

// Only output leaves and host guidance may differ; compare every original envelope,
// including call parameters, IDs, signatures and result metadata.
function assertPreserved(output: Body, original: Body, protocol: Protocol, expectedOld: string): void {
  const expected = structuredClone(original);
  setText(expected, toolSpans(original, protocol)[0]!.path, expectedOld);
  const key = keyFor(protocol);
  const actual = structuredClone(output);
  let guidance: string;
  if (protocol === 'chat' || protocol === 'anthropic') {
    const content = actual[key].at(-1).content;
    assert.ok(content.length > expected[key].at(-1).content.length, 'guidance is appended after recent content');
    assert.ok(content.slice(1).every((part: Body) => part.type === 'text' && typeof part.text === 'string'));
    guidance = content.slice(1).map((part: Body) => part.text).join('\n');
    actual[key].at(-1).content = content.slice(0, 1);
  } else {
    assert.equal(actual[key].length, expected[key].length + 1);
    const guide = extractSpans(actual, protocol).at(-1)!;
    assert.equal(guide.role, 'user');
    guidance = guide.text;
    actual[key].pop();
  }
  assert.match(guidance, /^<context-folding scope=[a-f0-9]{64}>\ntools\["context_folding"\]/);
  assert.doesNotMatch(guidance, /<context-budget>|source-fold-markers|@context-fold|Folding mode:|Agentic:/);
  assert.equal(guidance.includes('read(scope,id)'), expectedOld !== toolSpans(original, protocol)[0]!.text,
    'read guidance is only included while the request contains folded history');
  assert.deepEqual(actual, expected);
  assert.equal(toolSpans(output, protocol)[1]!.text, toolSpans(original, protocol)[1]!.text);
  const spans = extractSpans(output, protocol);
  assert.ok(spans.some(span => span.text === recentAnswer));
  assert.ok(spans.some(span => span.text === requirements));
}

async function fixture(variant: Variant, run: (store: Store, scope: string, ctx: Body) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'folding-duplicate-protocols-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    const session = `duplicate-protocol-${variant.protocol}-${variant.custom ? 'custom' : 'function'}`;
    const store = new Store(directory);
    const scope = await store.scopeFor(JSON.stringify([session, '', '', '']));
    await run(store, scope, { protocol: variant.protocol, model: 'synthetic', session,
      options: { mode: 'intelligence', thresholdTokens: 1, keepRecentMessages: 3, headChars: 400,
        policy: { mode: 'bytes', autoRoles: ['tool'], minChars: 4096 } } });
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

for (const variant of variants) {
  const { protocol } = variant;
  const label = protocol + (variant.custom ? '/custom' : '');
  test(`${label}: onRequest folds exact repeated outputs, replays once and recovers the complete original`, async () => {
    await fixture(variant, async (store, scope, ctx) => {
      const body = request(variant);
      const untouched = structuredClone(body);
      const [old, anchor] = toolSpans(body, protocol);
      assert.ok(old && anchor);
      const output = await onRequest(body, ctx) as Body;
      const folded = toolSpans(output, protocol)[0]!.text;
      assert.ok(folded.startsWith(`[context-folding duplicate id=${old.id} role=tool]\n`));
      assert.ok(folded.includes(`Exact repeat of JSON path ${JSON.stringify(anchor.path)}`));
      assert.ok(folded.includes('Same text, separate observation.'));
      assert.ok(folded.includes('Opening: same JSON path UTF-16 [0,400)'));
      assert.ok(folded.includes(`Original UTF-16: inline [0,400); archived [0,${evidence.length})`));
      assert.ok(!folded.includes(JSON.stringify(evidence.slice(0, 400))));
      assertPreserved(output, body, protocol, folded);
      assert.deepEqual(body, untouched, 'onRequest must not mutate its input');
      const read = JSON.parse(await execute({ action: 'read', scope, id: old.id, peek: true, limit: 24000 }));
      assert.equal(read.text, evidence);
      assert.deepEqual(await onRequest(body, ctx), output, 'unchanged request replays the same alias');
      const archived = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
      assert.equal(archived.entries.find(entry => entry.id === old.id)!.layers.length, 1);
      await execute({ action: 'mark', scope, marks: [{ id: old.id, disposition: 'keep' }] });
      const restored = await onRequest(body, ctx) as Body;
      assertPreserved(restored, body, protocol, evidence);
      assert.equal(toolSpans(restored, protocol)[0]!.text, evidence);
    });
  });

  test(`${label}: legacy literal openings replay unchanged and invalidate when their anchor changes`, async () => {
    await fixture(variant, async (store, scope, ctx) => {
      const body = request(variant);
      const [old, anchor] = toolSpans(body, protocol);
      const output = await onRequest(body, ctx) as Body;
      const alias = toolSpans(output, protocol)[0]!.text;
      const legacy = alias.replace('Opening: same JSON path UTF-16 [0,400)', `Opening: ${JSON.stringify(evidence.slice(0, 400))}`);
      assert.notEqual(legacy, alias);
      await store.transaction(scope, false, 64 * 1024 * 1024, state => {
        state.entries.find(entry => entry.id === old!.id)!.folded = legacy;
      });
      const noNewFolds = { ...ctx, options: { ...ctx.options, thresholdTokens: Number.MAX_SAFE_INTEGER } };
      const replayed = await onRequest(body, noNewFolds) as Body;
      assertPreserved(replayed, body, protocol, legacy);
      const changed = structuredClone(body);
      setText(changed, anchor!.path, evidence + 'Changed anchor.');
      assertPreserved(await onRequest(changed, noNewFolds) as Body, changed, protocol, evidence);
    });
  });

  test(`${label}: anchor movement rewrites its path and changed or missing anchors never replay stale aliases`, async () => {
    await fixture(variant, async (_store, _scope, ctx) => {
      const body = request(variant);
      const initial = await onRequest(body, ctx) as Body;
      const initialAlias = toolSpans(initial, protocol)[0]!.text;
      assert.match(initialAlias, /^\[context-folding duplicate /);
      const shifted = structuredClone(body);
      const key = keyFor(protocol);
      shifted[key].splice(2, 0, structuredClone(shifted[key][2]));
      const anchor = toolSpans(shifted, protocol)[1]!;
      const moved = await onRequest(shifted, ctx) as Body;
      const movedAlias = toolSpans(moved, protocol)[0]!.text;
      assert.match(movedAlias, /^\[context-folding duplicate /);
      assert.notEqual(movedAlias, initialAlias);
      assert.ok(movedAlias.includes(`Exact repeat of JSON path ${JSON.stringify(anchor.path)}`));
      assertPreserved(moved, shifted, protocol, movedAlias);
      const noNewFolds = { ...ctx, options: { ...ctx.options, thresholdTokens: Number.MAX_SAFE_INTEGER } };
      const changed = structuredClone(shifted);
      setText(changed, anchor.path, evidence + 'New evidence changes this observation.');
      const restored = await onRequest(changed, noNewFolds) as Body;
      assertPreserved(restored, changed, protocol, evidence);
      assert.equal(toolSpans(restored, protocol)[0]!.text, evidence);
      const absent = structuredClone(shifted);
      absent[key].splice(anchor.messageIndex - 1, 2);
      const withoutAnchor = await onRequest(absent, noNewFolds) as Body;
      assert.equal(toolSpans(withoutAnchor, protocol).length, 1);
      assert.equal(toolSpans(withoutAnchor, protocol)[0]!.text, evidence);
      assert.ok(!JSON.stringify(withoutAnchor).includes('[context-folding duplicate '));
      assert.deepEqual(body, request(variant));
    });
  });
}

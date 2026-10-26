import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans } from '../src/protocol.js';
import { Store } from '../src/store.js';
import { execute } from '../src/tool.js';

const text = Array.from({ length: 120 }, (_, i) => `line ${i}: ${'original'.repeat(20)}`).join('\n');
const changed = text.replace('line 0:', 'updated line 0:');
const tools = [{ type: 'function', function: { name: 'context_folding', parameters: { type: 'object' } } }];
type Read = { path: string; text: string; id: string; offset?: number };
const body = (reads: Read[]) => ({ model: 'synthetic', tools, messages: [
  ...reads.flatMap(read => [
    { role: 'assistant', content: null, tool_calls: [{ id: read.id, type: 'function',
      function: { name: 'Read', arguments: JSON.stringify({ file_path: read.path,
        ...(read.offset === undefined ? {} : { offset: read.offset }) }) } }] },
    { role: 'tool', tool_call_id: read.id, content: read.text },
  ]),
  { role: 'user', content: 'Current requirements.' },
] });

test('trimmed identical reads never inherit another file or range summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folding-source-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    for (const source of [{ path: '/b.ts' }, { path: '/a.ts', offset: 100 }]) {
      const ctx = { protocol: 'chat', model: 'synthetic', session: JSON.stringify(source), cwd: directory,
        options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 0, policy: { mode: 'bytes' } } };
      const initial = body([
        { path: '/a.ts', text, id: 'a-old' }, { path: '/a.ts', text: changed, id: 'a-new' },
        { ...source, text, id: 'current' },
      ]);
      const initialResult = await onRequest(initial, ctx);
      const folded = extractSpans(initialResult as Record<string, unknown>, 'chat').filter(span => span.role === 'tool');
      assert.ok(folded[0]?.text.startsWith('[context-folding'));
      assert.ok(folded[1]?.text === changed, 'The latest A observation must remain original');
      assert.ok(folded[2]?.text === text, 'The latest B observation must remain original');
      const store = new Store(directory);
      const scope = await store.scopeFor(JSON.stringify([ctx.session, '', '', ctx.cwd]));
      const before = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
      const trimmed = body([{ ...source, text, id: 'current' }]);
      assert.ok(isDeepStrictEqual(await onRequest(trimmed, ctx), trimmed), 'A source conflict must retain the complete original request');
      assert.ok(isDeepStrictEqual(await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => snapshot), before),
        'A source conflict must not change the archive');
      for (const entry of before.entries.filter(entry => entry.role === 'tool')) {
        const original = JSON.parse(await execute({ scope, action: 'read', id: entry.id, peek: true, limit: 24000 }));
        assert.ok(original.text === entry.text, `Original ${entry.id} must round-trip exactly`);
        for (const layer of entry.layers) {
          const recovered = JSON.parse(await execute({ scope, action: 'read', id: entry.id, layer: layer.id, peek: true }));
          assert.ok(recovered.text === layer.text, `Layer ${layer.id} must round-trip exactly`);
          assert.equal(recovered.previousId, layer.previousId);
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('losing read provenance never replays a file summary into generic output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'folding-source-loss-'));
  const previous = process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
  process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = directory;
  try {
    const ctx = { protocol: 'chat', model: 'synthetic', session: 'source-loss', cwd: directory,
      options: { thresholdTokens: 1, keepRecentMessages: 1, headChars: 0, policy: { mode: 'bytes' } } };
    await onRequest(body([{ path: '/a.ts', text, id: 'old' }, { path: '/a.ts', text: changed, id: 'new' }]), ctx);
    const generic = { model: 'synthetic', tools, messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'unattributed', type: 'function',
        function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'unattributed', content: text }, { role: 'user', content: 'Current requirements.' },
    ] };
    assert.ok(isDeepStrictEqual(await onRequest(generic, ctx), generic), 'Missing provenance must retain the original request');
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR;
    else process.env.MAGPIE_CONTEXT_FOLDING_STATE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

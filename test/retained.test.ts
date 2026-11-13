import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { bodyFor, fixture } from './helpers.js';
import { digest } from '../src/store.js';

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: outer fold uses dots, keeps literal examples and archives the complete original`, async () => {
    await fixture(async ({ context, scope, store }) => {
      const island = '→ 不折叠开始\n>> Literal example <<\n[[cf:v2:123456789abc]]\n<< Literal end >>\n← 不折叠结束\n';
      const original = 'evidence before '.repeat(600) + '\n' + island + 'evidence after '.repeat(600);
      const input = bodyFor(protocol, '>> Investigating <<\n' + original + '\n<< Verified >>');
      const ctx = { ...context, options: { delayRequests: 0 } };
      const projected = await onRequest(input, ctx) as Record<string, unknown>;
      const text = extractSpans(projected, protocol).find(span => span.role === 'assistant')!.text;
      assert.ok(text.includes(island));
      assert.ok(!text.includes('evidence before'));
      assert.ok(!text.includes('evidence after'));
      assert.ok(text.endsWith('...\n<< Verified >>'));
      const path = /^path:(.+)$/m.exec(text)?.[1];
      assert.ok(path);
      assert.equal(await readFile(path, 'utf8'), original);
      assert.ok(path.endsWith(digest(original) + '.txt'));
      assert.deepEqual(await onRequest(projected, ctx), projected);
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1);
      assert.deepEqual(extractSpans(input, protocol).find(span => span.role === 'assistant')!.text,
        '>> Investigating <<\n' + original + '\n<< Verified >>');
    }, protocol);
  });
}

test('a later parent can archive a known dots projection as a child', async () => {
  await fixture(async ({ context, store, scope }) => {
    const ctx = { ...context, options: { delayRequests: 0 } };
    const leaf = 'precise original evidence '.repeat(600);
    const first = await onRequest(bodyFor('chat', '>> Child <<\n' + leaf + '\n<< Child done >>'), ctx) as Record<string, unknown>;
    const childView = extractSpans(first, 'chat').find(span => span.role === 'assistant')!.text;
    assert.ok(childView.includes('...'));
    const parent = 'parent evidence '.repeat(600) + '\n' + childView + '\n' + 'parent result '.repeat(600);
    const input = bodyFor('chat', '>> Parent <<\n' + parent + '\n<< Parent done >>');
    const output = await onRequest(input, ctx) as Record<string, unknown>;
    const text = extractSpans(output, 'chat').find(span => span.role === 'assistant')!.text;
    assert.ok(text.includes('...'));
    assert.ok(!text.includes('parent evidence'));
    const path = /^path:(.+)$/m.exec(text)?.[1];
    assert.ok(path);
    assert.equal(await readFile(path, 'utf8'), parent);
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot));
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries.find(entry => entry.text === parent)!.annotation!.children!.length, 1);
  });
});

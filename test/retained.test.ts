import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { onRequest } from '../src/context.hooks.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { bodyFor, fixture } from './helpers.js';
import { digest } from '../src/store.js';

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(`${protocol}: leading literal islands preserve the original reference on replay`, async () => {
    await fixture(async ({ context, scope, store }) => {
      const island = '→ 不折叠开始\n[[cf:v2:123456789abc]]\nkeep\n← 不折叠结束\n';
      const original = island + 'original evidence';
      const ctx = { ...context, options: { delayRequests: 0 } };
      const projected = await onRequest(bodyFor(protocol, '>> Review <<\n' + original + '\n<< Done >>'), ctx) as Record<string, unknown>;
      const text = extractSpans(projected, protocol).find(span => span.role === 'assistant')!.text;
      assert.ok(text.includes(island));
      const path = /^path:(.+)$/m.exec(text)?.[1];
      assert.ok(path);
      assert.equal(await readFile(path, 'utf8'), original);
      let replayed = projected;
      for (let index = 0; index < 3; index++) {
        replayed = await onRequest(replayed, ctx) as Record<string, unknown>;
        assert.deepEqual(replayed, projected);
      }
      const entries = await store.transaction(scope, false, 64 * 1024 * 1024, snapshot => structuredClone(snapshot.entries));
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.text, original);
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1);
    }, protocol);
  });

  test(`${protocol}: many literal islands do not inflate the projected folding cost`, async () => {
    await fixture(async ({ context, scope, store }) => {
      const island = '→ 不折叠开始\nkeep\n← 不折叠结束\n';
      const original = Array.from({ length: 30 }, () => 'evidence '.repeat(15) + '\n' + island).join('') + 'done';
      const input = bodyFor(protocol, '>> Review <<\n' + original + '\n<< Done >>');
      const ctx = { ...context, options: { delayRequests: 0 } };
      const projected = await onRequest(input, ctx) as Record<string, unknown>;
      const text = extractSpans(projected, protocol).find(span => span.role === 'assistant')!.text;
      assert.equal(text.split(island).length - 1, 30);
      assert.ok(!text.includes('evidence'));
      assert.equal((text.match(/^tokens_method:/gm) ?? []).length, 1);
      const path = /^path:(.+)$/m.exec(text)?.[1];
      assert.ok(path);
      assert.equal(await readFile(path, 'utf8'), original);
      assert.deepEqual(await onRequest(projected, ctx), projected);
      assert.equal((await store.readStats(scope)).metrics.itemsFolded, 1);
    }, protocol);
  });

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
    const leaf = '→ 不折叠开始\nkeep\n← 不折叠结束\n' + 'precise original evidence '.repeat(600);
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

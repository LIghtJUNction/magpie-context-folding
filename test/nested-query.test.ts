import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { onRequest } from '../src/context.hooks.js';
import { parseRegions } from '../src/annotations.js';
import { withoutBudget } from '../src/budget.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { digest, type Snapshot } from '../src/store.js';
import { execute } from '../src/tool.js';
import { bodyFor, fixture, progress } from './helpers.js';

const block = (label: string, text: string) => '@context-fold begin ' + label + '\n' + text + '\n@context-fold end ' + label;
const call = async (input: unknown) => JSON.parse(await execute(input));
const assistant = (body: unknown, protocol: Protocol = 'chat') => extractSpans(body as Record<string, unknown>, protocol)
  .filter(span => span.role === 'assistant').map(span => span.text).join('');
const nested = () => {
  const leaf = 'needle-leaf ' + 'precise evidence '.repeat(30);
  const middle = 'middle note\n' + block('leaf', leaf) + '\nmiddle decision';
  const outer = 'outer note\n' + block('middle', middle) + '\nouter decision';
  return { leaf, middle, outer, text: block('outer', outer) };
};

for (const protocol of ['chat', 'responses', 'anthropic', 'gemini'] as Protocol[]) {
  test(protocol + ': nested bodies are durable and only the outermost projection is published', async () => {
    await fixture(async ({ context, scope, store }) => {
      const data = nested();
      const input = bodyFor(protocol, data.text);
      const output = await onRequest(input, { ...context, options: { delayRequests: 0 } });
      const projected = assistant(output, protocol);
      assert.equal(projected.match(/\[\[cf:v2:/g)?.length, 1);
      assert.ok(projected.includes(digest(data.outer).slice(0, 12)));
      assert.ok(!projected.includes('needle-leaf'));
      const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
      assert.equal(state.entries.length, 3);
      for (const [label, text] of [['leaf', data.leaf], ['middle', data.middle], ['outer', data.outer]]) {
        const entry = state.entries.find(entry => entry.annotation?.label === label)!;
        assert.equal(entry.text, text);
        for (const edge of entry.annotation?.children ?? []) {
          const child = state.entries.find(entry => entry.id === edge.id)!;
          assert.equal(entry.text.slice(edge.start, edge.end), child.text);
        }
      }
      const parent = await call({ action: 'read', scope, id: digest(data.outer).slice(0, 12) });
      assert.ok(parent.text.includes('[[cf:v2:' + digest(data.middle).slice(0, 12)));
      assert.ok(!parent.text.includes('needle-leaf'));
      assert.equal(parent.sha256, digest(data.outer));
      const middle = await call({ action: 'read', scope, id: digest(data.middle).slice(0, 12) });
      assert.ok(middle.text.includes('[[cf:v2:' + digest(data.leaf).slice(0, 12)));
      const after = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
      assert.deepEqual(after.entries, state.entries);
      assert.equal(after.metrics.itemsRestored, 0);
      assert.deepEqual(await onRequest(output, { ...context, options: { delayRequests: 0 } }), output);
    }, protocol);
  });
}

test('recursive list/grep/meta reveal only bounded requested views and keep every fold intact', async () => {
  await fixture(async ({ context, scope, store, directory }) => {
    const leaf = Array.from({ length: 35 }, (_, index) => 'needle ' + index + ' ' + 'x'.repeat(220)).join('\r\n');
    const parent = 'parent heading\r\n' + block('child', leaf) + '\r\nparent ending';
    await onRequest(bodyFor('chat', block('parent', parent)), { ...context, options: { delayRequests: 0 } });
    const before = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    const id = digest(parent);
    const list = await call({ action: 'list', scope, id: id.slice(0, 12), recursive: true });
    assert.deepEqual(list.entries.map((entry: { depth: number }) => entry.depth), [0, 1]);
    assert.equal(list.entries[0].childCount, 1);
    assert.ok(!JSON.stringify(list).includes('needle 0'));
    const meta = await call({ action: 'meta', scope, id });
    assert.equal(meta.childCount, 1);
    assert.deepEqual(meta.children, [digest(leaf)]);
    assert.ok(!JSON.stringify(meta).includes('needle'));
    const found = await call({ action: 'grep', scope, id, query: 'needle' });
    assert.equal(found.total, 35);
    assert.equal(found.matches.length, 10);
    assert.equal(found.nextOffset, 10);
    assert.ok(found.matches.every((match: { id: string; text: string }) => match.id === digest(leaf) && match.text.length <= 160));
    assert.equal((await call({ action: 'grep', scope, id, query: 'needle', recursive: false })).total, 0);
    const page = await call({ action: 'grep', scope, id, query: 'needle', offset: 10, limit: 2 });
    assert.deepEqual(page.matches.map((match: { line: number }) => match.line), [11, 12]);
    const read = await call({ action: 'read', scope, id: digest(leaf) });
    assert.equal(read.text.length, 1200);
    assert.equal(read.nextOffset, 1200);
    const lines = await call({ action: 'read', scope, id: digest(leaf), startLine: 11, endLine: 12 });
    assert.equal(lines.text, leaf.split('\r\n').slice(10, 12).join('\r\n') + '\r\n');
    const file = join(directory, 'parent-view');
    await call({ action: 'paste', scope, id, path: file });
    assert.ok(!(await readFile(file, 'utf8')).includes('needle'));
    const after = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.groups, before.groups);
  });
});

test('nested regions spanning assistant messages preserve all tool structures and child offsets', async () => {
  await fixture(async ({ context, scope, store }) => {
    const leaf = 'first ' + 'evidence '.repeat(60) + 'second';
    const first = '@context-fold begin parent\nhead\n@context-fold begin child\n' + leaf.slice(0, 200);
    const last = leaf.slice(200) + '\n@context-fold end child\nfoot\n@context-fold end parent';
    const toolCall = { role: 'assistant', content: first,
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'exec', arguments: '{"code":"work()"}' } }] };
    const toolResult = { role: 'tool', tool_call_id: 'call', content: 'The tool result stays exact.' };
    const body = { ...bodyFor('chat'), messages: [toolCall, toolResult, { role: 'assistant', content: last }] };
    const output = await onRequest(body, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const clean = withoutBudget(output, 'chat').messages as Record<string, unknown>[];
    assert.deepEqual(clean[0]!.tool_calls, toolCall.tool_calls);
    assert.deepEqual(clean[1], toolResult);
    assert.ok(assistant(output).includes('[[cf:v2:'));
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.equal(state.entries.length, 2);
    const parent = state.entries.find(entry => entry.annotation?.label === 'parent')!;
    const child = state.entries.find(entry => entry.annotation?.label === 'child')!;
    assert.equal(child.text, leaf);
    const edge = parent.annotation!.children![0]!;
    assert.equal(parent.text.slice(edge.start, edge.end), leaf);
    const query = await call({ action: 'read', scope, id: parent.id });
    assert.equal(query.text, 'head\n@context-fold begin child\n[[cf:v2:' + digest(leaf).slice(0, 12) + ']]\n@context-fold end child\nfoot');
  });
});

test('a later parent closes around a known child reference without expanding or rearchiving the reference', async () => {
  await fixture(async ({ context, scope, store }) => {
    const leaf = 'child detail '.repeat(100);
    const open = '@context-fold begin parent\nheading\n' + block('child', leaf) + '\n';
    const initial = { ...bodyFor('chat'), messages: [{ role: 'assistant', content: open }] };
    const first = await onRequest(initial, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.ok(assistant(first).includes('[[cf:v2:' + digest(leaf).slice(0, 12)));
    const next = structuredClone(first);
    (next.messages as unknown[]).push({ role: 'assistant', content: 'ending\n@context-fold end parent' });
    const second = await onRequest(next, { ...context, options: { delayRequests: 0 } });
    assert.ok(!assistant(second).includes('heading'));
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.equal(state.entries.length, 2);
    const parent = state.entries.find(entry => entry.annotation?.label === 'parent')!;
    assert.ok(parent.text.includes('[[cf:v2:'));
    assert.ok(!parent.text.includes(leaf));
    assert.equal(parent.annotation!.children![0]!.id, digest(leaf));
    assert.equal((await call({ action: 'read', scope, id: parent.id })).text, parent.text);
  });
});

test('unknown child references and mismatched or user-crossing parent ranges never disappear', async () => {
  await fixture(async ({ context }) => {
    const unknown = block('parent', 'heading\n' + block('child', '[[cf:v2:123456789abc]]') + '\nend');
    const input = bodyFor('chat', unknown);
    assert.deepEqual(withoutBudget(await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>, 'chat'), input);
    const part = 'evidence '.repeat(100);
    const split = { ...bodyFor('chat'), messages: [
      { role: 'assistant', content: '@context-fold begin parent\n@context-fold begin child\n' + part },
      { role: 'user', content: 'Boundary' },
      { role: 'assistant', content: '\n@context-fold end child\n@context-fold end parent' },
    ] };
    assert.deepEqual(withoutBudget(await onRequest(split, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>, 'chat'), split);
    const malformed = '@context-fold begin parent\n' + block('closed', part) + '\n@context-fold begin broken\nvisible\n@context-fold end parent';
    const output = await onRequest(bodyFor('chat', malformed), { ...context, options: { delayRequests: 0 } });
    assert.ok(assistant(output).includes('visible'));
    assert.ok(assistant(output).includes('[[cf:v2:' + digest(part).slice(0, 12)));
    assert.deepEqual(parseRegions([{ id: 'a', text: malformed }]).map(region => region.label), ['closed']);
  });
});

test('nested projection cannot reset a later sibling grace period', async () => {
  await fixture(async ({ context, scope, store }) => {
    const a = block('a', block('a-child', 'A'.repeat(800)));
    const b = block('b', 'B'.repeat(800));
    await onRequest(bodyFor('chat', a), context);
    const second = await onRequest(bodyFor('chat', a + '\n' + b), context) as Record<string, unknown>;
    assert.ok(assistant(second).includes('B'.repeat(800)));
    const third = await onRequest(progress(second, 'chat'), context);
    assert.ok(!assistant(third).includes('B'.repeat(800)));
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    const entry = state.entries.find(entry => entry.annotation?.label === 'b')!;
    assert.equal(Object.values(entry.occurrences!)[0]!.firstSeen, 1);
    assert.equal(Object.values(entry.occurrences!)[0]!.lastSeen, 2);
  });
});

test('archive child edges reject dangling, overlapping and cyclic structures without changing originals', async () => {
  await fixture(async ({ context, scope, store }) => {
    const parentText = 'header\n' + block('tiny-child', 'x') + '\n' + 'footer '.repeat(20);
    await onRequest(bodyFor('chat', block('parent', parentText)), { ...context, options: { delayRequests: 0 } });
    const before = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.equal(before.entries.length, 2, 'tiny children are retained when a parent folds');
    const mutate = (change: (state: Snapshot) => void) => store.transaction(scope, false, 64 * 1024 * 1024, change);
    await assert.rejects(mutate(state => { state.entries.find(entry => entry.annotation?.label === 'parent')!.annotation!.children![0]!.id = 'missing'; }), /child range/);
    await assert.rejects(mutate(state => {
      const parent = state.entries.find(entry => entry.annotation?.label === 'parent')!;
      parent.annotation!.children = [{ id: parent.id, label: 'self', start: 0, end: parent.text.length }];
    }), /Cyclic annotation/);
    assert.deepEqual(await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state)), before);
  });
});

test('repeated child bodies keep direct edges while recursive grep visits their content once', async () => {
  await fixture(async ({ context, scope }) => {
    const leaf = 'single needle ' + 'same content '.repeat(40);
    const parent = block('first', leaf) + '\n' + block('second', leaf);
    await onRequest(bodyFor('chat', block('parent', parent)), { ...context, options: { delayRequests: 0 } });
    const id = digest(parent);
    const meta = await call({ action: 'meta', scope, id });
    assert.equal(meta.childCount, 2);
    assert.deepEqual(meta.children, [digest(leaf), digest(leaf)]);
    const list = await call({ action: 'list', scope, id, recursive: true });
    assert.equal(list.total, 2);
    assert.equal(list.entries[0].childCount, 2);
    const found = await call({ action: 'grep', scope, id, query: 'single needle' });
    assert.equal(found.total, 1);
    assert.equal(found.matches[0].id, digest(leaf));
  });
});

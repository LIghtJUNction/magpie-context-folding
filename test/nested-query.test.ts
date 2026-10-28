import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { onRequest } from '../src/context.hooks.js';
import { parseRegions } from '../src/annotations.js';
import { withoutGuidance } from '../src/guidance.js';
import { estimateTokens } from '../src/metrics.js';
import { extractSpans, type Protocol } from '../src/protocol.js';
import { digest, type Snapshot } from '../src/store.js';
import { execute } from '../src/tool.js';
import { bodyFor, fixture, progress } from './helpers.js';

const block = (label: string, text: string) => '@context-fold begin ' + label + '\n' + text + '\n@context-fold end ' + label;
const call = async (input: unknown) => JSON.parse(await execute(input));
const assistant = (body: unknown, protocol: Protocol = 'chat') => extractSpans(body as Record<string, unknown>, protocol)
  .filter(span => span.role === 'assistant').map(span => span.text).join('');
const nested = () => {
  const leaf = 'needle-leaf ' + 'precise evidence '.repeat(200);
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
      assert.equal(state.metrics.foldedTokensEstimated,
        String(estimateTokens(input) - estimateTokens(withoutGuidance(output as Record<string, unknown>, protocol))),
        'nested children do not double count the outermost replacement');
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
    const leaf = 'first ' + 'evidence '.repeat(300) + 'second';
    const first = '@context-fold begin parent\nhead\n@context-fold begin child\n' + leaf.slice(0, 200);
    const last = leaf.slice(200) + '\n@context-fold end child\nfoot\n@context-fold end parent';
    const toolCall = { role: 'assistant', content: first,
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'exec', arguments: '{"code":"work()"}' } }] };
    const toolResult = { role: 'tool', tool_call_id: 'call', content: 'The tool result stays exact.' };
    const body = { ...bodyFor('chat'), messages: [toolCall, toolResult, { role: 'assistant', content: last }] };
    const output = await onRequest(body, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    const clean = withoutGuidance(output, 'chat').messages as Record<string, unknown>[];
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
    const leaf = 'child detail '.repeat(250);
    const open = '@context-fold begin parent\n' + 'heading context '.repeat(200) + '\n' + block('child', leaf) + '\n';
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
    assert.equal((await call({ action: 'read', scope, id: parent.id, limit: 24000 })).text, parent.text);
    assert.equal(state.metrics.itemsFolded, 2, 'the already folded reference is not a new fold');
  });
});

test('unknown child references and mismatched or user-crossing parent ranges never disappear', async () => {
  await fixture(async ({ context }) => {
    const unknown = block('parent', 'heading\n' + block('child', '[[cf:v2:123456789abc]]') + '\nend');
    const input = bodyFor('chat', unknown);
    assert.deepEqual(withoutGuidance(await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>, 'chat'), input);
    const part = 'evidence '.repeat(400);
    const split = { ...bodyFor('chat'), messages: [
      { role: 'assistant', content: '@context-fold begin parent\n@context-fold begin child\n' + part },
      { role: 'user', content: 'Boundary' },
      { role: 'assistant', content: '\n@context-fold end child\n@context-fold end parent' },
    ] };
    assert.deepEqual(withoutGuidance(await onRequest(split, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>, 'chat'), split);
    const malformed = '@context-fold begin parent\n' + block('closed', part) + '\n@context-fold begin broken\nvisible\n@context-fold end parent';
    const output = await onRequest(bodyFor('chat', malformed), { ...context, options: { delayRequests: 0 } });
    assert.ok(assistant(output).includes('visible'));
    assert.ok(assistant(output).includes('[[cf:v2:' + digest(part).slice(0, 12)));
    assert.deepEqual(parseRegions([{ id: 'a', text: malformed }]).map(region => region.label), ['closed']);
  });
});

test('nested projection cannot reset a later sibling grace period', async () => {
  await fixture(async ({ context, scope, store }) => {
    const a = block('a', block('a-child', 'A'.repeat(4000)));
    const b = block('b', 'B'.repeat(4000));
    await onRequest(bodyFor('chat', a), context);
    const second = await onRequest(bodyFor('chat', a + '\n' + b), context) as Record<string, unknown>;
    assert.ok(assistant(second).includes('B'.repeat(4000)));
    const third = await onRequest(progress(second, 'chat'), context);
    assert.ok(!assistant(third).includes('B'.repeat(4000)));
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    const entry = state.entries.find(entry => entry.annotation?.label === 'b')!;
    assert.equal(Object.values(entry.occurrences!)[0]!.firstSeen, 1);
    assert.equal(Object.values(entry.occurrences!)[0]!.lastSeen, 2);
  });
});

test('archive child edges reject dangling, overlapping and cyclic structures without changing originals', async () => {
  await fixture(async ({ context, scope, store }) => {
    const parentText = 'header\n' + block('tiny-child', 'x') + '\n' + 'footer '.repeat(400);
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
    const leaf = 'single needle ' + 'same content '.repeat(250);
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

test('restoring a shared child protects every enclosing annotation and legacy group', async () => {
  await fixture(async ({ context, scope, store }) => {
    const leaf = 'exact shared detail 🙂\r\n'.repeat(180);
    const parents = ['first parent', 'second parent'].map(label => label + '\n' + block('shared', leaf) + '\nend');
    const input = bodyFor('chat', parents.map((text, index) => block('parent-' + index, text)).join('\n'));
    await onRequest(input, { ...context, options: { delayRequests: 0 } });
    await store.transaction(scope, false, 64 * 1024 * 1024, state => {
      state.groups = [{ id: 'legacy-group', children: parents.map(digest), summary: 'legacy', enabled: true, folded: 'legacy summary' }];
    });
    const before = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.equal(before.entries.length, 3);
    assert.ok(before.entries.every(entry => entry.folded));
    assert.equal((await call({ action: 'read', scope, id: digest(leaf), limit: 24000 })).text, leaf);
    const queried = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.deepEqual(queried.entries, before.entries);
    assert.deepEqual(queried.groups, before.groups);
    const restored = await call({ action: 'read', scope, id: digest(leaf), layer: 'original', peek: false, limit: 24000 });
    assert.equal(restored.text, leaf);
    const after = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.ok(after.entries.every(entry => entry.mark.disposition === 'keep' && entry.folded === undefined));
    assert.equal(after.groups![0]!.enabled, false);
    assert.equal(after.groups![0]!.folded, undefined);
    assert.equal(after.metrics.itemsRestored, 4);
    const next = await onRequest(input, { ...context, options: { delayRequests: 0 } }) as Record<string, unknown>;
    assert.deepEqual(withoutGuidance(next, 'chat'), input, 'no enclosing fold can hide the explicitly restored child');
  });
});

test('CLI complete views, original exports and restoration preserve nested Unicode originals', async () => {
  await fixture(async ({ context, scope, store, directory }) => {
    const leaf = 'exact 中文🙂\r\n'.repeat(2500);
    const heading = 'parent context '.repeat(140);
    const parent = heading + '\n' + block('child', leaf) + '\nparent ending';
    await onRequest(bodyFor('chat', block('parent', parent)), { ...context, options: { delayRequests: 0 } });
    const before = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    const view = heading + '\n' + block('child', '[[cf:v2:' + digest(leaf).slice(0, 12) + ']]') + '\nparent ending';
    const invoke = (...args: string[]) => spawnSync(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname,
      'read', '--state-dir', store.directory, '--scope', scope, '--id', digest(parent), ...args], { encoding: 'utf8' });
    const complete = invoke();
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(complete.stdout, view, 'ordinary CLI reads return the complete view');
    const bounded = invoke('--limit', '1200');
    assert.equal(bounded.status, 0, bounded.stderr);
    assert.equal(bounded.stdout, view.slice(0, 1200));
    for (const [flags, expected] of [[['--full'], view], [['--all'], parent], [['--all', '--layer', 'view'], view],
      [['--full', '--offset', '1400'], view.slice(1400)]] as [string[], string][]) {
      const exported = invoke(...flags);
      assert.equal(exported.status, 0, exported.stderr);
      assert.equal(exported.stdout, expected);
    }
    const path = join(directory, 'nested-view');
    await call({ action: 'paste', scope, id: digest(parent), path });
    assert.equal(await readFile(path, 'utf8'), view);
    for (const flags of [['--restore', '--limit', '1'], ['--restore', '--offset', '1'], ['--restore', '--layer', 'view']]) {
      assert.equal(invoke(...flags).status, 1, 'restore cannot silently return a partial or derived view');
    }
    const queried = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.deepEqual(queried.entries, before.entries);
    assert.equal(queried.metrics.itemsRestored, 0);
    const restored = invoke('--restore');
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(restored.stdout, parent, 'restoration pages the complete exact original, including child bodies and CRLF');
    const after = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.ok(after.entries.every(entry => entry.mark.disposition === 'keep' && entry.folded === undefined));
  });
});

test('net-savings rejection retains the complete waiting-parent closure without orphan archives', async () => {
  const expensiveCommand = 'command-' + 'x'.repeat(3000);
  const parent = block('tiny', 'x') + '\n' + 'waiting context '.repeat(110);
  await fixture(async ({ context, scope, store }) => {
    const input = bodyFor('chat', block('parent', parent));
    const rejected = await onRequest(input, { ...context, options: { delayRequests: 0,
      minSavingsTokens: 0, recoveryCommand: expensiveCommand } }) as Record<string, unknown>;
    assert.deepEqual(withoutGuidance(rejected, 'chat'), input);
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.equal(state.entries.length, 0, 'a rejected new parent leaves no descendant archive');
  });
  await fixture(async ({ context, scope, store }) => {
    const matured = block('matured', 'm'.repeat(1500));
    const options = { delayRequests: 1, minSavingsTokens: 0, recoveryCommand: expensiveCommand };
    await onRequest(bodyFor('chat', matured), { ...context, options });
    const input = bodyFor('chat', matured + '\n' + block('parent', parent));
    const rejected = await onRequest(input, { ...context, options }) as Record<string, unknown>;
    assert.deepEqual(withoutGuidance(rejected, 'chat'), input);
    const state = await store.transaction(scope, false, 64 * 1024 * 1024, state => structuredClone(state));
    assert.equal(state.entries.length, 3);
    const waiting = state.entries.find(entry => entry.id === digest(parent))!;
    assert.deepEqual(waiting.annotation!.children!.map(child => child.id), [digest('x')]);
    assert.equal(state.entries.find(entry => entry.id === digest('x'))!.text, 'x');
    assert.equal(Object.values(waiting.occurrences!)[0]!.firstSeen, 1);
    assert.equal(state.decision.foldedRegions, 0);
    assert.ok(Number(state.decision.waiting) > 0 && Number(state.decision.skipped) > 0);
    const next = await onRequest(progress(input, 'chat'), { ...context, options: { delayRequests: 1, minSavingsTokens: 0 } });
    assert.equal(assistant(next).match(/\[\[cf:v2:/g)?.length, 2, 'the saved waiting cursor can mature on the next request');
  });
});

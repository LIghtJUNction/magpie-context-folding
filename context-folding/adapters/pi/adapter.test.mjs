import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCore, createReadAdapter, querySnapshot, restoreOriginal, scopeFor, entryType } from './adapter.mjs';

function context(cwd, session = 'one', entries = []) {
  return { cwd, sessionManager: { getSessionId: () => session, getBranch: () => entries } };
}
const source = `# @context-fold begin example\ndef example():\n${Array.from({ length: 180 }, (_, i) => `    value_${i} = '原文 ${i} 🐦'`).join('\n')}\n    return value_0\n# @context-fold end example\n`;
function event(text, input = { path: 'sample.py' }) {
  return { toolName: 'read', isError: false, input, content: [{ type: 'text', text }], details: { untouched: true } };
}

test('core sends large private payload through stdin, never process argv', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-stdin-'));
  try {
    const probe = join(directory, 'probe');
    await writeFile(probe, `#!/usr/bin/python3 -I\nimport json, sys\npayload = json.load(sys.stdin)\nassert sys.argv[-2:] == ['--json', '-']\nassert not any('PRIVATE_SOURCE_SENTINEL' in arg for arg in sys.argv)\nassert len(payload['text']) > 131072\nprint(json.dumps({'result': {'stdinLength': len(payload['text'])}}))\n`);
    await chmod(probe, 0o700);
    const text = 'PRIVATE_SOURCE_SENTINEL' + 'x'.repeat(200000);
    const result = await createCore({ statePath: join(directory, 'state.sqlite'), python: probe })({ action: 'put', scope: 'stdin-test', text });
    assert.equal(result.stdinLength, text.length);
    // Verify the production Python CLI also accepts a payload beyond Linux's single-arg cap.
    const stored = await createCore({ statePath: join(directory, 'state.sqlite') })({ action: 'put', scope: 'stdin-test', text });
    assert.equal(typeof stored.id, 'string');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real core round trip, scope and branch isolation, immutable snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-fold-'));
  try {
    await writeFile(join(directory, '.context-folding.toml'), '[folding]\ndelay_requests=0\n');
    const call = createCore({ statePath: join(directory, 'archive.sqlite'), projectDir: directory });
    const entries = [], ctx = context(directory, 'one', entries);
    const adapter = createReadAdapter({ call, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
    const original = event(source);
    const result = await adapter(original, ctx);
    assert.ok(result.content[0].text.length < source.length);
    assert.equal(original.content[0].text, source);
    const id = entries[0].data.id;
    assert.equal(await restoreOriginal(call, ctx, id), source);
    assert.notEqual(scopeFor(ctx), scopeFor(context(directory, 'two')));
    assert.notEqual(scopeFor(ctx), scopeFor(context('/different', 'one')));
    await assert.rejects(restoreOriginal(call, context(directory, 'two', entries), id));
    await assert.rejects(restoreOriginal(call, context(directory, 'one', []), id));
    const foreign = await call({ action: 'put', scope: 'unrelated', text: 'secret' });
    await assert.rejects(restoreOriginal(call, ctx, foreign.id));
    assert.equal(entries[0].customType, entryType);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Pi queries stay bounded, recursive and tied to active branch snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-query-'));
  try {
    await writeFile(join(directory, '.context-folding.toml'), '[folding]\ndelay_requests=0\n');
    const call = createCore({ statePath: join(directory, 'archive.sqlite'), projectDir: directory });
    const entries = [], ctx = context(directory, 'query-session', entries);
    const adapter = createReadAdapter({ call, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
    assert.ok(await adapter(event(source), ctx));
    const rootId = entries[0].data.id;
    const listing = await querySnapshot(call, ctx, { action: 'list' });
    assert.equal(listing.entries[0].id, rootId);
    const child = listing.entries.find(entry => entry.id !== rootId);
    assert.ok(child?.reference.startsWith('[[cf:v2:'));
    const hash = child.reference.slice(8, -2);
    const page = await querySnapshot(call, ctx, { action: 'read', id: hash, limit: 80 });
    assert.ok(page.text.includes('def example'));
    assert.ok(Array.from(page.text).length <= 80, `Expected 80 code points, got ${Array.from(page.text).length}`);
    const found = await querySnapshot(call, ctx, { action: 'grep', query: 'value_99', limit: 2 });
    assert.ok(found.matches.some(match => match.text.includes('value_99')));
    const metadata = await querySnapshot(call, ctx, { action: 'meta', id: rootId });
    assert.ok(metadata.children.includes(child.id));
    await assert.rejects(querySnapshot(call, context(directory, 'different', entries), { action: 'list' }));
    await assert.rejects(querySnapshot(call, context(directory, 'query-session', []), { action: 'read', id: hash }));
    const unrelated = await call({ action: 'put', scope: scopeFor(ctx), text: 'unrelated private entry' });
    await assert.rejects(querySnapshot(call, ctx, { action: 'read', id: unrelated.id }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failure, image, unsupported, error and malformed range leave results untouched', async () => {
  let called = 0;
  const adapter = createReadAdapter({ call: async () => { called++; throw Error('offline'); }, appendEntry() {} });
  const ctx = context('/project');
  for (const input of [event(source), { ...event(source), toolName: 'edit' },
    { ...event(source), isError: true }, event(source, { path: 'x.py', offset: -1 }),
    event(source, { path: 'x.py', limit: 1.2 }), event(source, { path: 'x.ts' }),
    { ...event(source), content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }]) {
    const copy = structuredClone(input);
    assert.equal(await adapter(input, ctx), undefined);
    assert.deepEqual(input, copy);
  }
  assert.equal(called, 1);
});

test('installed Pi read uses exact offset/limit output, no file reread by adapter', { skip: !process.env.PI_PACKAGE_ROOT }, async () => {
  const root = process.env.PI_PACKAGE_ROOT;
  const { createReadToolDefinition } = await import(pathToFileURL(join(root, 'dist/core/tools/read.js')));
  const directory = await mkdtemp(join(tmpdir(), 'pi-read-'));
  try {
    const file = join(directory, 'sample.py');
    await writeFile(file, `# excluded first line\n${source}`);
    const input = { path: file, offset: 2, limit: 500 };
    const ctx = context(directory), entries = [];
    ctx.sessionManager.getBranch = () => entries;
    const actual = await createReadToolDefinition(directory).execute('read-1', input, undefined, undefined, ctx);
    const output = event(actual.content[0].text, input);
    await writeFile(join(directory, '.context-folding.toml'), '[folding]\ndelay_requests=0\n');
    const call = createCore({ statePath: join(directory, 'state.sqlite'), projectDir: directory });
    const adapter = createReadAdapter({ call, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
    await writeFile(file, 'changed after tool read');
    const folded = await adapter(output, ctx);
    assert.ok(folded);
    const restored = await restoreOriginal(call, ctx, entries[0].data.id);
    assert.equal(restored, actual.content[0].text);
    assert.ok(!restored.includes('excluded first line'));
    assert.ok(!restored.includes('excluded last line'));
    // Real Pi continuation notices are not valid Python: leave that range unchanged.
    await writeFile(file, `# excluded first line\n${source}# excluded last line\n`);
    const partialInput = { path: file, offset: 2, limit: source.split('\n').length - 1 };
    const partial = await createReadToolDefinition(directory).execute('read-2', partialInput, undefined, undefined, ctx);
    assert.ok(partial.content[0].text.includes('Use offset='));
    assert.equal(await adapter(event(partial.content[0].text, partialInput), ctx), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('no-benefit and persistence failures preserve existing pin state', async () => {
  for (const previouslyPinned of [false, true]) {
    for (const failure of ['no-benefit', 'append-failed']) {
      let pinned = previouslyPinned, pinCalls = 0, appended = false;
      const call = async request => {
        if (request.action === 'annotate') return { id: 'snapshot', sha256: createHash('sha256').update(source).digest('hex') };
        if (request.action === 'pin') { pinCalls++; pinned = request.pinned; return {}; }
        const text = request.mode === 'original' || failure === 'no-benefit' ? source : 'def example(): ...';
        return { id: 'snapshot', offset: 0, text, nextOffset: null,
          totalChars: Array.from(text).length, sha256: createHash('sha256').update(text).digest('hex'),
          foldedRegions: failure === 'no-benefit' ? [] : [{ id: 'work' }] };
      };
      const adapter = createReadAdapter({ call, appendEntry() { appended = true; throw Error('session unavailable'); } });
      assert.equal(await adapter(event(source), context('/project')), undefined);
      assert.equal(pinned, previouslyPinned);
      assert.equal(pinCalls, 0);
      assert.equal(appended, failure === 'append-failed');
    }
  }
});

test('publication requires complete restoration and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-persist-'));
  try {
    await writeFile(join(directory, '.context-folding.toml'), '[folding]\ndelay_requests=0\n');
    const call = createCore({ statePath: join(directory, 'state.sqlite'), projectDir: directory });
    const adapter = createReadAdapter({ call, appendEntry() { throw Error('session persistence failed'); } });
    assert.equal(await adapter(event(source), context(directory)), undefined);
    const broken = createReadAdapter({ call: async request => request.action === 'annotate'
      ? { id: 'fake' } : { id: 'fake', offset: 0, text: '', nextOffset: null, totalChars: 99, sha256: 'invalid' },
    appendEntry() { assert.fail('must not publish'); } });
    assert.equal(await broken(event(source), context(directory)), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('default delay preserves fresh reads without a replay-cycle hook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-default-'));
  try {
    const call = createCore({ statePath: join(directory, 'state.sqlite'), projectDir: directory });
    let records = 0;
    const adapter = createReadAdapter({ call, appendEntry() { records++; } });
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(await adapter(event(source), context(directory)), undefined);
    }
    assert.equal(records, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
